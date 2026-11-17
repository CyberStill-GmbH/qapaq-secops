/**
 * Analista IA — adaptador del modelo y configuración de despliegue. Cliente simulado: nunca se
 * llama a un proveedor real.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { InferenceNotSentError, type ModelRequest } from '@qapaq/assistant';

import {
  BUILT_IN_ANALYST_RATE_CARD,
  loadAnalystConfig,
} from '../src/assistant/analyst-config.js';
import {
  analystThinkingFor,
  createAnalystMessagesClient,
  createAnalystModel,
  provablyNotSent,
} from '../src/assistant/analyst-model.js';
import type { MessagesClient } from '../src/assistant/claude-model.js';

const REQUEST: ModelRequest = {
  system: 'Eres el analista. token=abcd1234secret',
  messages: [{ role: 'user', content: 'Evidencia: Bearer abcdefghijklmnop' }],
  tools: [],
  maxTokens: 700,
  allowTools: false,
};

function fakeClient(outcome: (params: Anthropic.MessageCreateParamsNonStreaming) => unknown) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        const result = outcome(params);
        if (result instanceof Error) throw result;
        return result as Anthropic.Message;
      },
    },
  };
  return { client, calls };
}

const OK = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: '{"verdict":"inconclusive"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
  },
};

describe('adaptador del modelo del analista', () => {
  it('una sola llamada sin herramientas, max_tokens explícito, caché en el sistema y salida saneada', async () => {
    const { client, calls } = fakeClient(() => OK);
    const model = createAnalystModel({ model: 'claude-haiku-5-5', tier: 'economy' }, client);
    const response = await model.complete(REQUEST);
    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.max_tokens).toBe(700);
    expect(params.tools).toBeUndefined();
    expect(params).not.toHaveProperty('tool_choice');
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]!.text).not.toContain('abcd1234secret');
    expect(JSON.stringify(params.messages)).not.toContain('abcdefghijklmnop');
    expect(params.thinking).toEqual({ type: 'disabled' });
    expect((params as unknown as { output_config: unknown }).output_config).toEqual({
      effort: 'low',
    });
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 900,
      cacheWriteTokens: 50,
    });
    expect(response.stopReason).toBe('end_turn');
  });

  it('elige la forma de apagar el pensamiento según el modelo', () => {
    expect(analystThinkingFor('claude-haiku-5-5')).toEqual({ type: 'disabled' });
    expect(analystThinkingFor('anthropic.claude-sonnet-5-5')).toEqual({ type: 'between_tools' });
    expect(analystThinkingFor('claude-opus-5-5')).toBeUndefined();
  });

  it('InferenceNotSentError solo cuando se demuestra que no se envió', async () => {
    const notSent = [
      Anthropic.APIError.generate(429, {}, 'rate limited', new Headers()),
      Anthropic.APIError.generate(400, {}, 'bad request', new Headers()),
      new Anthropic.APIConnectionError({
        cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      }),
    ];
    for (const error of notSent) {
      expect(provablyNotSent(error)).toBe(true);
      const model = createAnalystModel(
        { model: 'claude-haiku-5-5', tier: 'economy' },
        fakeClient(() => error).client,
      );
      await expect(model.complete(REQUEST)).rejects.toBeInstanceOf(InferenceNotSentError);
    }
    const ambiguous = [
      Anthropic.APIError.generate(500, {}, 'server', new Headers()),
      new Anthropic.APIConnectionTimeoutError(),
      new Anthropic.APIConnectionError({
        cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      }),
      new Anthropic.APIUserAbortError(),
      new Error('cualquier otra cosa'),
    ];
    for (const error of ambiguous) {
      expect(provablyNotSent(error)).toBe(false);
      const model = createAnalystModel(
        { model: 'claude-haiku-5-5', tier: 'economy' },
        fakeClient(() => error).client,
      );
      const thrown = await model.complete(REQUEST).catch((caught: unknown) => caught);
      expect(thrown).not.toBeInstanceOf(InferenceNotSentError);
      // El mensaje del SDK (que puede citar la solicitud) no se propaga.
      expect((thrown as Error).message).toBe('MODEL_OUTCOME_UNKNOWN');
    }
  });

  it('una señal ya abortada o una solicitud inválida no se envían', async () => {
    const { client, calls } = fakeClient(() => OK);
    const model = createAnalystModel({ model: 'claude-sonnet-5-5', tier: 'advanced' }, client);
    const controller = new AbortController();
    controller.abort();
    await expect(model.complete(REQUEST, controller.signal)).rejects.toBeInstanceOf(
      InferenceNotSentError,
    );
    await expect(model.complete({ ...REQUEST, maxTokens: 0 })).rejects.toBeInstanceOf(
      InferenceNotSentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('el cliente del proveedor no reintenta', () => {
    const client = createAnalystMessagesClient({
      provider: 'anthropic',
      apiKey: 'sk-ant-test-not-real',
      timeoutMs: 30_000,
    }) as unknown as { maxRetries: number };
    expect(client.maxRetries).toBe(0);
  });
});

describe('configuración de despliegue del analista', () => {
  it('apagado por defecto, modelos y tarifa de fábrica, sin inferencia sin techo', () => {
    const config = loadAnalystConfig({});
    expect(config.enabled).toBe(false);
    expect(config.provider).toBeUndefined();
    expect(config.models).toEqual({
      economy: 'anthropic.claude-haiku-5-5',
      advanced: 'anthropic.claude-sonnet-5-5',
    });
    expect(config.dailyCeilingMicroUsd).toBeNull();
    expect(config.rateCard).toBe(BUILT_IN_ANALYST_RATE_CARD);
    expect(config.rateCard.version).toMatch(/estimate/u);
    expect(config).toMatchObject({ concurrency: 1, backlogSweep: true });
  });

  it('reutiliza el proveedor de Qapaqzito y respeta el prefijo de Bedrock', () => {
    const anthropic = loadAnalystConfig({
      QAPAQ_ANALYST_ENABLED: 'true',
      QAPAQ_QAPAQZITO_PROVIDER: 'anthropic',
      QAPAQ_QAPAQZITO_API_KEY: 'sk-ant-test-not-real',
      QAPAQ_ANALYST_DAILY_CEILING_USD: '3',
      QAPAQ_ANALYST_CONCURRENCY: '2',
    });
    expect(anthropic.models.economy).toBe('claude-haiku-5-5');
    expect(anthropic.provider).toMatchObject({ provider: 'anthropic' });
    expect(anthropic.dailyCeilingMicroUsd).toBe(3_000_000);
    expect(anthropic.concurrency).toBe(2);
    expect(() => loadAnalystConfig({ QAPAQ_ANALYST_ENABLED: 'true' })).toThrow(/AWS_REGION/u);
    expect(() =>
      loadAnalystConfig({ QAPAQ_ANALYST_ENABLED: 'true', QAPAQ_QAPAQZITO_PROVIDER: 'anthropic' }),
    ).toThrow(/QAPAQ_QAPAQZITO_API_KEY/u);
    expect(() => loadAnalystConfig({ QAPAQ_ANALYST_CONCURRENCY: '9' })).toThrow();
  });
});
