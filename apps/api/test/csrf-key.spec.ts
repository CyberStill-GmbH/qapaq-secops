import { describe, expect, it } from 'vitest';

import { csrfTokenFor, deriveCsrfKey } from '../src/http/csrf.js';

describe('clave CSRF compartida entre réplicas', () => {
  it('deriva el mismo token de sesión desde el secreto persistente y separa su propósito', () => {
    const sharedSecret = 'synthetic-master-key-for-csrf-test-0001';
    const firstReplicaKey = deriveCsrfKey(sharedSecret);
    const secondReplicaKey = deriveCsrfKey(sharedSecret);

    expect(firstReplicaKey).toHaveLength(32);
    expect(firstReplicaKey).not.toEqual(Buffer.from(sharedSecret));
    expect(csrfTokenFor(firstReplicaKey, 'opaque-session-id')).toBe(
      csrfTokenFor(secondReplicaKey, 'opaque-session-id'),
    );
    expect(csrfTokenFor(firstReplicaKey, 'another-session-id')).not.toBe(
      csrfTokenFor(secondReplicaKey, 'opaque-session-id'),
    );
  });

  it('separa las claves derivadas de secretos distintos', () => {
    expect(deriveCsrfKey('synthetic-master-key-one-000000000000')).not.toEqual(
      deriveCsrfKey('synthetic-master-key-two-000000000000'),
    );
  });
});
