import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CATALOG,
  API_ERROR_CODES,
  apiError,
  type ApiErrorCode,
} from '../src/api-error/catalog.js';

describe('C-27 · catálogo de errores', () => {
  it('define cada código declarado, y solo esos', () => {
    expect(Object.keys(API_ERROR_CATALOG).sort()).toEqual([...API_ERROR_CODES].sort());
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_CATALOG[code].code).toBe(code);
    }
  });

  it('asigna un estado HTTP válido a cada entrada', () => {
    for (const definition of Object.values(API_ERROR_CATALOG)) {
      expect(definition.httpStatus).toBeGreaterThanOrEqual(400);
      expect(definition.httpStatus).toBeLessThan(600);
    }
  });

  it('publica un helpRef resoluble y único por código', () => {
    const refs = Object.values(API_ERROR_CATALOG).map((definition) => definition.helpRef);

    for (const ref of refs) expect(() => new URL(ref)).not.toThrow();
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('entrega mensajes accionables, sin detalle técnico', () => {
    for (const definition of Object.values(API_ERROR_CATALOG)) {
      expect(definition.publicMessage.length).toBeGreaterThan(10);
      expect(definition.publicMessage).not.toMatch(
        /stack|SQL|prisma|postgres|undefined|null|exception|\/src\//iu,
      );
      expect(definition.publicMessage.endsWith('.')).toBe(true);
    }
  });

  it('no enumera: no existe y no autorizado comparten respuesta', () => {
    const unavailable = API_ERROR_CATALOG.RESOURCE_UNAVAILABLE;

    expect(unavailable.httpStatus).toBe(404);
    expect(unavailable.publicMessage).not.toMatch(/permis|autoriz|existe/iu);
    expect(API_ERROR_CODES.filter((code) => code.includes('NOT_FOUND'))).toEqual([]);
    expect(API_ERROR_CODES.filter((code) => code.includes('FORBIDDEN'))).toEqual([]);
  });

  it('marca como reintentable solo lo que puede cambiar sin intervención', () => {
    const retriable = API_ERROR_CODES.filter((code) => API_ERROR_CATALOG[code].retriable);

    expect(retriable.sort()).toEqual(
      ['DEPENDENCY_DEGRADED', 'INTERNAL_ERROR', 'RATE_LIMITED', 'STATE_CONFLICT'].sort(),
    );
  });

  it('construye el cuerpo con correlationId siempre presente', () => {
    const body = apiError('STATE_CONFLICT', 'corr-123');

    expect(body).toMatchObject({
      code: 'STATE_CONFLICT',
      correlationId: 'corr-123',
      action: 'reload_resource',
      retriable: true,
    });
    expect(Object.hasOwn(body, 'fields')).toBe(false);
  });

  it('incluye los campos en validación sin devolver el valor recibido', () => {
    const body = apiError('VALIDATION_FAILED', 'corr-123', ['note']);

    expect(body.fields).toEqual(['note']);
    expect(JSON.stringify(body)).not.toContain('value');
  });

  it('mantiene estable el contrato de códigos entre versiones', () => {
    // Añadir códigos es compatible; quitar o renombrar rompe a los consumidores.
    const expected: readonly ApiErrorCode[] = [
      'AUTH_REQUIRED',
      'AUTH_FAILED',
      'SESSION_EXPIRED',
      'PASSKEY_REQUIRED',
      'NETWORK_NOT_ALLOWED',
      'REQUEST_NOT_VERIFIED',
      'RATE_LIMITED',
      'RESOURCE_UNAVAILABLE',
      'STATE_CONFLICT',
      'VALIDATION_FAILED',
      'DEPENDENCY_DEGRADED',
      'INTEGRATION_NOT_CONFIGURED',
      'INTERNAL_ERROR',
    ];

    for (const code of expected) expect(API_ERROR_CODES).toContain(code);
  });
});
