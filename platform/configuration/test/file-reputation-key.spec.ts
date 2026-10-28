import { describe, expect, it } from 'vitest';

import { loadVirusTotalApiKey } from '../src/index.js';
import { rejectUnknownQapaqVariables } from '../src/schema/environment.schema.js';

describe('clave opcional de reputación por hash', () => {
  it('sin clave la integración queda sin configurar, no es un error', () => {
    expect(loadVirusTotalApiKey({ QAPAQ_PROFILE: 'production' })).toBeUndefined();
    expect(
      loadVirusTotalApiKey({ QAPAQ_PROFILE: 'production', QAPAQ_VIRUSTOTAL_API_KEY: '' }),
    ).toBeUndefined();
  });

  it('acepta una clave alfanumérica, tolera el salto de línea final y no la expone', () => {
    const key = loadVirusTotalApiKey({
      QAPAQ_PROFILE: 'production',
      QAPAQ_VIRUSTOTAL_API_KEY: `${'0a'.repeat(32)}\n`,
    });
    expect(key?.reveal()).toBe('0a'.repeat(32));
    expect(JSON.stringify({ key })).not.toContain('0a0a');
  });

  it('rechaza una clave con forma inválida', () => {
    expect(() =>
      loadVirusTotalApiKey({ QAPAQ_PROFILE: 'production', QAPAQ_VIRUSTOTAL_API_KEY: '"clave"' }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_VALUE_INVALID' }));
  });

  it('la variable y su referencia son conocidas para el arranque', () => {
    expect(() =>
      rejectUnknownQapaqVariables({
        QAPAQ_VIRUSTOTAL_API_KEY_REF: 'secret://keyvault/qapaq-virustotal-api-key',
      }),
    ).not.toThrow();
  });
});
