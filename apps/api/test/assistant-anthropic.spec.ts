import { describe, expect, it } from 'vitest';

import { AssistantConfigError, loadAssistantConfig } from '../src/assistant/assistant-config.js';
import { createClaudeModel, type MessagesClient } from '../src/assistant/claude-model.js';
import { scrubCredentials } from '../src/assistant/outbound-scrub.js';

function enabled(env: Record<string, string>) {
  const config = loadAssistantConfig(env);
  if (!config.enabled) throw new Error('config');
  return config;
}

describe('Qapaqzito con la API directa de Anthropic', () => {
  it('usa claude-sonnet-5-5 por defecto, configurable, con timeout por defecto de 20 s', () => {
    const base = {
      QAPAQ_QAPAQZITO_ENABLED: 'true',
      QAPAQ_QAPAQZITO_PROVIDER: 'anthropic',
      QAPAQ_QAPAQZITO_API_KEY: 'k',
    };
    expect(enabled(base)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      timeoutMs: 20_000,
    });
    expect(
      enabled({ ...base, QAPAQ_QAPAQZITO_MODEL: 'claude-opus-5-5', QAPAQ_QAPAQZITO_TIMEOUT_MS: '45000' }),
    ).toMatchObject({
      model: 'claude-opus-5-5',
      timeoutMs: 45_000,
    });
    expect(() => loadAssistantConfig({ ...base, QAPAQ_QAPAQZITO_TIMEOUT_MS: '5' })).toThrow(
      AssistantConfigError,
    );
  });

  it('Bedrock no cambia: claude-opus-5-5 con prefijo anthropic.', () => {
    expect(enabled({ QAPAQ_QAPAQZITO_ENABLED: 'true', AWS_REGION: 'us-east-1' })).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-opus-5-5',
    });
  });

  it('ya no acepta deepseek como proveedor', () => {
    expect(() =>
      loadAssistantConfig({
        QAPAQ_QAPAQZITO_ENABLED: 'true',
        QAPAQ_QAPAQZITO_PROVIDER: 'deepseek',
        QAPAQ_QAPAQZITO_API_KEY: 'k',
      }),
    ).toThrow(AssistantConfigError);
  });
});

describe('minimización de credenciales hacia el modelo', () => {
  it('elimina credenciales evidentes y conserva los marcadores del seudonimizador', () => {
    const text = [
      'Authorization: Bearer abcdefghijklmnop.qrs',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl',
      'AKIAABCDEFGHIJKLMNOP',
      'key sk-ant-api03-0123456789abcdef',
      'password=Sup3rS3cret! y "client_secret": "abc123xyz"',
      'https://admin:hunter2@example.com/x',
      '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
    ].join('\n');
    const scrubbed = scrubCredentials(text);
    for (const secret of [
      'abcdefghijklmnop',
      'eyJhbGciOiJIUzI1NiJ9',
      'AKIAABCDEFGHIJKLMNOP',
      'sk-ant-api03-0123456789abcdef',
      'Sup3rS3cret',
      'abc123xyz',
      'hunter2',
      'MIIB',
    ]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubCredentials('Alerta de <usuario_1> desde <ip_2>, regla 100503')).toBe(
      'Alerta de <usuario_1> desde <ip_2>, regla 100503',
    );
  });

  it('el adaptador limpia sistema, preguntas y resultados de herramientas pero no el razonamiento firmado', async () => {
    let sent = '';
    const client = {
      messages: {
        async create(params: unknown) {
          sent = JSON.stringify(params);
          return {
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    } as unknown as MessagesClient;
    const model = createClaudeModel(
      enabled({
        QAPAQ_QAPAQZITO_ENABLED: 'true',
        QAPAQ_QAPAQZITO_PROVIDER: 'anthropic',
        QAPAQ_QAPAQZITO_API_KEY: 'k',
      }),
      client,
    );
    await model.complete({
      system: 'sistema token=abcd1234efgh',
      messages: [
        { role: 'user', content: 'mi clave es sk-ant-api03-0123456789abcdef' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'razonamiento password=keep-intact', signature: 'sig' },
            { type: 'tool_use', id: 't1', name: 'get_alert', input: { id: 'a1' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '{"api_key":"zzzz9999yyyy"}' },
          ],
        },
      ],
      tools: [],
      maxTokens: 10,
      allowTools: true,
    });
    expect(sent).not.toContain('abcd1234efgh');
    expect(sent).not.toContain('sk-ant-api03-0123456789abcdef');
    expect(sent).not.toContain('zzzz9999yyyy');
    expect(sent).toContain('password=keep-intact');
  });
});

describe('fallback ante negativas', () => {
  it('con la API directa usa el endpoint beta con fallbacks "default" e ignora el bloque fallback', async () => {
    let sent: Record<string, unknown> = {};
    let stable = false;
    const client = {
      messages: {
        async create() {
          stable = true;
          throw new Error('no debe usarse');
        },
      },
      beta: {
        messages: {
          async create(params: Record<string, unknown>) {
            sent = params;
            return {
              content: [
                { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'x' } },
                { type: 'text', text: 'ok' },
              ],
              stop_reason: 'end_turn',
              usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 4 },
            };
          },
        },
      },
    } as unknown as MessagesClient;
    const model = createClaudeModel(
      enabled({ QAPAQ_QAPAQZITO_ENABLED: 'true', QAPAQ_QAPAQZITO_PROVIDER: 'anthropic', QAPAQ_QAPAQZITO_API_KEY: 'k' }),
      client,
    );
    const response = await model.complete({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      maxTokens: 10,
      allowTools: true,
    });
    expect(stable).toBe(false);
    expect(sent).toMatchObject({
      model: 'claude-sonnet-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(response.usage.cacheReadTokens).toBe(4);
  });
});
