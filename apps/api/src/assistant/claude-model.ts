/**
 * Adaptador del puerto `AssistantModel` hacia Claude. Usa el SDK oficial: el cliente de Anthropic
 * (`anthropic`) o el de Amazon Bedrock Mantle (`bedrock`); ambos exponen `messages.create`.
 *
 * Decisiones:
 * - Cada llamada lleva `AbortSignal` (presupuesto del turno) además del timeout por intento.
 * - Pensamiento adaptativo (por omisión en los modelos actuales) y profundidad con `effort`; no se
 *   usan `temperature`, prefill ni `tool_choice` forzado (no soportados en estos modelos).
 * - Una negativa del modelo (`refusal`) se devuelve como tal; el dominio la comunica sin inventar.
 * - Minimización: además de la seudonimización del dominio, todo texto saliente (sistema, preguntas,
 *   resultados de herramientas) pasa por `scrubCredentials`. Los bloques firmados del proveedor
 *   (`thinking`) solo se reenvían intactos dentro del turno que necesita continuar herramientas;
 *   el dominio no los guarda ni los devuelve a la persona.
 * - Robustez: `timeout` por intento (`QAPAQ_QAPAQZITO_TIMEOUT_MS`) y 2 reintentos con backoff exponencial
 *   del SDK ante 408/409/429/5xx o error de red. Nunca se registran prompts ni respuestas.
 * - Caché de prompt: herramientas + sistema forman un prefijo estable (orden determinista, sin datos
 *   variables) con un punto de caché en el sistema; además, `cache_control` de nivel superior
 *   cachea el historial creciente entre rondas de herramientas del mismo turno.
 * - Fallback ante negativas (solo API directa de Anthropic): `fallbacks: "default"` (beta
 *   `server-side-fallback-2026-07-01`) re-ejecuta la petición en el modelo de respaldo cuando un
 *   clasificador de seguridad declina contenido legítimo del SOC (p. ej. técnicas de ataque).
 *   Bedrock no lo admite y usa la API estable.
 * - Sin streaming: la consola consume JSON completo a través del proxy del dashboard; el tiempo
 *   total lo acota el bucle del dominio (`deadlineMs`).
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type {
  AssistantModel,
  ConversationMessage,
  ModelBlock,
  ModelRequest,
  ModelResponse,
  ModelStopReason,
} from '@qapaq/assistant';

import type { AssistantConfig } from './assistant-config.js';
import { scrubCredentials, scrubCredentialsJson } from './outbound-scrub.js';

type EnabledConfig = Extract<AssistantConfig, { enabled: true }>;

/** Superficie mínima de `messages.create` que usa el adaptador (permite probarlo sin red). */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): Promise<Anthropic.Message>;
  };
  /** Solo con la API directa: endpoint beta para `fallbacks`. */
  beta?: {
    messages: {
      create(
        params: Anthropic.Beta.MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

/** Beta del fallback de servidor con el modo `"default"` (enruta según la categoría de la negativa). */
export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export function createMessagesClient(config: EnabledConfig): MessagesClient {
  if (config.provider === 'anthropic') {
    return new Anthropic({
      apiKey: config.apiKey,
      maxRetries: 2,
      timeout: config.timeoutMs,
    }) as unknown as MessagesClient;
  }
  return new AnthropicBedrockMantle({
    awsRegion: config.awsRegion,
    maxRetries: 1,
    timeout: config.timeoutMs,
  }) as unknown as MessagesClient;
}

function toParam(message: ConversationMessage): Anthropic.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: scrubCredentials(message.content) };
  }
  return {
    role: message.role,
    content: message.content.map((block): Anthropic.ContentBlockParam => {
      if (block.type === 'text') return { type: 'text', text: scrubCredentials(block.text) };
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: scrubCredentialsJson(block.input),
        };
      }
      if (block.type === 'thinking') {
        return { type: 'thinking', thinking: block.thinking, signature: block.signature };
      }
      if (block.type === 'redacted_thinking')
        return { type: 'redacted_thinking', data: block.data };
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: scrubCredentials(block.content),
        ...(block.is_error ? { is_error: true } : {}),
      };
    }),
  };
}

function stopReasonOf(reason: string | null): ModelStopReason {
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

export function createClaudeModel(
  config: EnabledConfig,
  client: MessagesClient = createMessagesClient(config),
): AssistantModel {
  return {
    async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
      const params = {
        model: config.model,
        max_tokens: request.maxTokens,
        // Caché automática del último bloque (historial del turno entre rondas de herramientas).
        cache_control: { type: 'ephemeral' as const },
        system: [
          {
            type: 'text' as const,
            text: scrubCredentials(request.system),
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        messages: request.messages.map(toParam),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...(request.allowTools ? {} : { tool_choice: { type: 'none' as const } }),
        // El proveedor puede incluir bloques internos; el dominio no los persiste ni los expone.
        thinking: { type: 'adaptive' as const, display: 'summarized' as const },
        output_config: { effort: config.effort },
      };
      const options = signal ? { signal } : undefined;
      const response: Anthropic.Message | Anthropic.Beta.BetaMessage =
        config.provider === 'anthropic' && client.beta
          ? await client.beta.messages.create(
              {
                ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming),
                betas: [SERVER_FALLBACK_BETA],
                fallbacks: 'default',
              },
              options,
            )
          : await client.messages.create(params, options);
      const content: ModelBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'thinking') {
          content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        } else if (block.type === 'redacted_thinking') {
          content.push({ type: 'redacted_thinking', data: block.data });
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      return {
        content,
        stopReason: stopReasonOf(response.stop_reason),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
