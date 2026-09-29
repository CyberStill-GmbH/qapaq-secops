import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { toPublicSecretError } from '../src/control-plane/secret-public-errors.js';
import type { SecretControlPlaneErrorCode } from '../src/control-plane/secret-lifecycle.types.js';

const CATALOG = new URL('../../../docs/error-catalog.md', import.meta.url);
const TYPES = new URL('../src/control-plane/secret-lifecycle.types.ts', import.meta.url);

/** Códigos internos declarados por el control plane, leídos de la fuente. */
async function internalCodes(): Promise<readonly SecretControlPlaneErrorCode[]> {
  const source = await readFile(TYPES, 'utf8');
  const union = source.slice(
    source.indexOf('export type SecretControlPlaneErrorCode'),
    source.indexOf(';', source.indexOf('export type SecretControlPlaneErrorCode')),
  );
  return [...union.matchAll(/'(SECRET_[A-Z_]+)'/gu)].map(
    (match) => match[1] as SecretControlPlaneErrorCode,
  );
}

/** Pares `helpRef / code` publicados en el catálogo de errores. */
async function publishedCatalog(): Promise<ReadonlyMap<string, string>> {
  const catalog = await readFile(CATALOG, 'utf8');
  const entries = [...catalog.matchAll(/(ERR-[A-Z]+-\d{3}) \/ `([A-Z_]+)`/gu)];
  return new Map(entries.map((entry) => [entry[1] as string, entry[2] as string]));
}

describe('C-24 mapeo al catálogo público de errores', () => {
  it('traduce todos los códigos internos declarados, sin omitir ninguno', async () => {
    const codes = await internalCodes();
    expect(codes.length).toBeGreaterThanOrEqual(13);
    for (const code of codes) {
      const published = toPublicSecretError(code);
      expect(published, code).toBeDefined();
      expect(published.status).toBeGreaterThanOrEqual(400);
      expect(published.status).toBeLessThan(600);
    }
  });

  it('solo usa códigos y helpRef que existen en docs/error-catalog.md', async () => {
    const [codes, catalog] = await Promise.all([internalCodes(), publishedCatalog()]);
    expect(catalog.size).toBeGreaterThan(10);
    for (const code of codes) {
      const published = toPublicSecretError(code);
      expect(catalog.get(published.helpRef), `${code} → ${published.helpRef}`).toBe(published.code);
    }
  });

  it('no publica el código interno ni filtra la causa al exterior', async () => {
    for (const code of await internalCodes()) {
      const published = toPublicSecretError(code);
      expect(published.code).not.toBe(code);
      expect(JSON.stringify(published)).not.toContain('SECRET_');
    }
  });

  it('asigna el contrato documentado a credencial rechazada y no entregada', () => {
    expect(toPublicSecretError('SECRET_PROVIDER_REJECTED')).toEqual({
      code: 'INTEGRATION_CREDENTIAL_REJECTED',
      status: 422,
      helpRef: 'ERR-SECRET-001',
      retryable: false,
    });
    expect(toPublicSecretError('SECRET_PROVIDER_UNAVAILABLE')).toEqual({
      code: 'INTEGRATION_CREDENTIAL_UNAVAILABLE',
      status: 503,
      helpRef: 'ERR-SECRET-002',
      retryable: true,
    });
  });

  it('no invita a reintentar un estado externo incierto', () => {
    expect(toPublicSecretError('SECRET_EXTERNAL_STATE_INCONSISTENT').retryable).toBe(false);
    expect(toPublicSecretError('SECRET_ROTATION_CONFLICT').retryable).toBe(false);
  });

  it('no distingue por código un recurso inexistente de uno no autorizado', () => {
    expect(toPublicSecretError('SECRET_NOT_FOUND').code).toBe(
      toPublicSecretError('SECRET_FORBIDDEN').code,
    );
  });
});
