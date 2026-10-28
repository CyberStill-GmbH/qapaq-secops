import { describe, expect, it } from 'vitest';

import { DEFAULT_ASSISTANT_MODEL, loadAssistantConfig, loadApiConfig } from '../src/index.js';

const TEST = { QAPAQ_PROFILE: 'test' } as const;
const SYNTHETIC_KEY = 'sk-ant-synthetic-test-key-0000000000';

describe('asistente · configuración', () => {
  it('sin API key el asistente queda sin configurar y el modelo toma el default', () => {
    const config = loadAssistantConfig(TEST);

    expect(config.apiKey).toBeUndefined();
    expect(config.model).toBe(DEFAULT_ASSISTANT_MODEL);
    expect(DEFAULT_ASSISTANT_MODEL).toBe('claude-sonnet-5-5');
  });

  it('acepta la key resuelta y el modelo declarado, sin exponer la key al serializar', () => {
    const config = loadAssistantConfig({
      ...TEST,
      QAPAQ_ANTHROPIC_API_KEY: SYNTHETIC_KEY,
      QAPAQ_ASSISTANT_MODEL: 'claude-opus-5-5',
    });

    expect(config.apiKey?.reveal()).toBe(SYNTHETIC_KEY);
    expect(config.model).toBe('claude-opus-5-5');
    expect(JSON.stringify(config)).not.toContain(SYNTHETIC_KEY);
  });

  it.each([
    ['QAPAQ_ASSISTANT_MODEL', 'gpt-4o'],
    ['QAPAQ_ASSISTANT_MODEL', 'claude sonnet'],
    ['QAPAQ_ANTHROPIC_API_KEY', 'corta'],
    ['QAPAQ_ANTHROPIC_API_KEY', `${SYNTHETIC_KEY}\notra-linea`],
    ['QAPAQ_ANTHROPIC_API_KEY', '{"key":"valor-pegado-en-el-secreto-equivocado"}'],
  ])('rechaza %s malformada al arrancar', (name, value) => {
    expect(() => loadAssistantConfig({ ...TEST, [name]: value })).toThrow(
      expect.objectContaining({ code: 'CONFIG_VALUE_INVALID', path: name }),
    );
  });

  it('las variables del asistente son conocidas: no bloquean el arranque del API', () => {
    expect(() =>
      loadApiConfig({
        ...TEST,
        QAPAQ_ANTHROPIC_API_KEY_REF: 'secret://keyvault/qapaq-anthropic-api-key',
        QAPAQ_ASSISTANT_MODEL: 'claude-sonnet-5-5',
      }),
    ).not.toThrow();
  });
});
