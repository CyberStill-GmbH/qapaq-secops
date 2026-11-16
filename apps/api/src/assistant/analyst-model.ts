/**
 * Adaptador del modelo para el Analista IA (docs/27). Comparte el SDK y la minimización de
 * `claude-model.ts`, pero con reglas de costo propias:
 *
 * - **Sin reintentos del SDK** (`maxRetries: 0`): cada envío está reservado y contabilizado en el
 *   libro de invocaciones; un reintento oculto podría facturar dos veces la misma reserva.
 * - **Sin herramientas**, `max_tokens` explícito (el que reservó el runner) y `cache_control` sobre
 *   el prompt de sistema estable (el paquete de evidencia va después, en el mensaje del usuario).
 * - **Sin pensamiento extendido en lo posible**: los tokens de pensamiento se facturan como salida
 *   y consumirían el `max_tokens` reservado. Haiku/Opus 5 y anteriores: `disabled`; Sonnet 5.5:
 *   `between_tools` (sin herramientas no piensa); Opus 5.5/Fable no admiten apagarlo, así que se
 *   omite y se baja `effort`. Económico con `effort: low`, avanzado con `medium`.
 * - **`InferenceNotSentError` solo si se demuestra que no se envió**: señal abortada antes de
 *   llamar, conexión rechazada/DNS antes de escribir, o un rechazo explícito del proveedor sin
 *   procesamiento (400/401/403/404/413/422/429/529). Todo lo demás (timeout, corte a mitad, 5xx,
 *   respuesta ilegible) se propaga como ambiguo: el runner deja la reserva `usage_unknown`.
 * - Todo texto saliente pasa por `scrubCredentials`. Nunca se registran prompts ni respuestas.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import {
  InferenceNotSentError,
  type AssistantModel,
  type InferenceTier,
  type ModelBlock,
  type ModelRequest,
  type ModelResponse,
  type ModelStopReason,
} from '@qapaq/assistant';

import type { AnalystProviderConfig } from './analyst-config.js';
import type { MessagesClient } from './claude-model.js';
import { scrubCredentials } from './outbound-scrub.js';

/** Cliente sin reintentos: un intento por reserva. */
export function createAnalystMessagesClient(config: AnalystProviderConfig): MessagesClient {
  if (config.provider === 'anthropic') {
    return new Anthropic({
      apiKey: config.apiKey,
      maxRetries: 0,
      timeout: config.timeoutMs,
    }) as unknown as MessagesClient;
  }
  return new AnthropicBedrockMantle({
    awsRegion: config.awsRegion,
    maxRetries: 0,
    timeout: config.timeoutMs,
  }) as unknown as MessagesClient;
}

type ThinkingParam = Anthropic.MessageCreateParamsNonStreaming['thinking'];

/** Configuración de pensamiento que minimiza tokens facturados como salida según el modelo. */
export function analystThinkingFor(model: string): ThinkingParam | undefined {
  const id = model.toLowerCase();
  if (/opus-5-5|fable|mythos/u.test(id)) return undefined;
  if (/sonnet-5-5/u.test(id)) return { type: 'between_tools' } as ThinkingParam;
  return { type: 'disabled' };
}

/** Códigos de conexión que prueban que la petición nunca se escribió. */
const NOT_SENT_CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);
/** Rechazos explícitos del proveedor: no procesó la solicitud ni reporta uso. */
const NOT_SENT_STATUSES = new Set([400, 401, 403, 404, 413, 422, 429, 529]);

function connectionCodeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** `true` solo si se puede demostrar que el proveedor no procesó la solicitud. */
export function provablyNotSent(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return false;
  if (error instanceof Anthropic.APIUserAbortError) return false;
  if (error instanceof Anthropic.APIConnectionError) {
    const code = connectionCodeOf(error.cause ?? error);
    return code !== undefined && NOT_SENT_CONNECTION_CODES.has(code);
  }
  if (error instanceof Anthropic.APIError) {
    return typeof error.status === 'number' && NOT_SENT_STATUSES.has(error.status);
  }
  return false;
}

function stopReasonOf(reason: string | null | undefined): ModelStopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return reason;
    default:
      return 'other';
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function createAnalystModel(
  binding: { readonly model: string; readonly tier: InferenceTier },
  client: MessagesClient,
): AssistantModel {
  const thinking = analystThinkingFor(binding.model);
  const effort = binding.tier === 'economy' ? 'low' : 'medium';
  return {
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      // Validación local antes de cualquier envío: lo rechazado aquí nunca salió.
      if (signal?.aborted) throw new InferenceNotSentError('MODEL_NOT_SENT');
      if (
        !Number.isInteger(request.maxTokens) ||
        request.maxTokens < 1 ||
        request.maxTokens > 8_000 ||
        request.messages.length === 0
      ) {
        throw new InferenceNotSentError('MODEL_REQUEST_INVALID');
      }
      const params = {
        model: binding.model,
        max_tokens: request.maxTokens,
        system: [
          {
            type: 'text' as const,
            text: scrubCredentials(request.system),
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        messages: request.messages.map(
          (message): Anthropic.MessageParam => ({
            role: message.role,
            content:
              typeof message.content === 'string'
                ? scrubCredentials(message.content)
                : message.content
                    .filter((block) => block.type === 'text')
                    .map((block) => ({
                      type: 'text' as const,
                      text: scrubCredentials((block as { text: string }).text),
                    })),
          }),
        ),
        ...(thinking ? { thinking } : {}),
        output_config: { effort },
      } as Anthropic.MessageCreateParamsNonStreaming;
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(params, signal ? { signal } : undefined);
      } catch (error) {
        // El error del SDK puede citar la solicitud: no se propaga su mensaje, solo la clase.
        if (provablyNotSent(error)) throw new InferenceNotSentError('MODEL_NOT_SENT');
        throw new Error('MODEL_OUTCOME_UNKNOWN');
      }
      const content: ModelBlock[] = [];
      for (const block of response.content ?? []) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
      }
      const usage = response.usage ?? ({} as Anthropic.Usage);
      return {
        content,
        stopReason: stopReasonOf(response.stop_reason),
        usage: {
          inputTokens: count(usage.input_tokens),
          outputTokens: count(usage.output_tokens),
          cacheReadTokens: count(usage.cache_read_input_tokens),
          cacheWriteTokens: count(usage.cache_creation_input_tokens),
        },
      };
    },
  };
}
