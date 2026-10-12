import { describe, expect, it } from 'vitest';

import { ENTITY_REF_PATTERN, entityRefFactory } from '../src/runtime/entity-refs.js';

/** D-10b — referencias opacas de entidad. */
describe('entityRefFactory', () => {
  const key = 'clave-de-prueba-de-al-menos-treinta-y-dos-caracteres';
  const ref = entityRefFactory(key);

  it('es determinista y cumple el formato publicado', () => {
    const value = ref('tenant-1', 'user:usuario@qapaq-lab.example');

    expect(value).toBe(ref('tenant-1', 'user:usuario@qapaq-lab.example'));
    expect(value).toMatch(ENTITY_REF_PATTERN);
  });

  it('no revela la entidad', () => {
    expect(ref('tenant-1', 'user:usuario@qapaq-lab.example')).not.toMatch(/usuario|qapaq/iu);
  });

  it('separa tenants: la misma entidad produce referencias distintas', () => {
    expect(ref('tenant-1', 'ip:203.0.113.24')).not.toBe(ref('tenant-2', 'ip:203.0.113.24'));
  });

  it('depende de la clave: sin ella no se puede recalcular', () => {
    const other = entityRefFactory(`${key}-otra`);
    expect(other('tenant-1', 'ip:203.0.113.24')).not.toBe(ref('tenant-1', 'ip:203.0.113.24'));
  });
});
