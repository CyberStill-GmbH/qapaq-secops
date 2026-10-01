import { describe, expect, it } from 'vitest';

import { evaluateNetwork, matchesCidr, type NetworkPolicy } from '../src/network.js';
import {
  consumeRateLimit,
  emptyCounter,
  evaluateLockout,
  LOCKOUT_POLICY,
  RATE_LIMIT_POLICY,
  registerFailure,
  registerSuccess,
} from '../src/lockout.js';
import { decideSignIn, policyForNetwork } from '../src/sign-in.js';
import { baseClaims } from './support/token-factory.js';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const policy: NetworkPolicy = {
  allowedCidrs: ['10.20.0.0/16', '2001:db8:abcd::/48'],
  trustedProxyCidrs: ['172.31.0.0/16'],
};

describe('C-25 · origen de red', () => {
  it('reconoce pertenencia a un CIDR en ambas familias', () => {
    expect(matchesCidr('10.20.5.9', '10.20.0.0/16')).toBe(true);
    expect(matchesCidr('10.21.5.9', '10.20.0.0/16')).toBe(false);
    expect(matchesCidr('2001:db8:abcd:1::5', '2001:db8:abcd::/48')).toBe(true);
    expect(matchesCidr('2001:db8:abce:1::5', '2001:db8:abcd::/48')).toBe(false);
  });

  it('normaliza una dirección IPv4 mapeada en IPv6', () => {
    expect(matchesCidr('::ffff:10.20.5.9', '10.20.0.0/16')).toBe(true);
  });

  it('clasifica dentro y fuera de la red QAPAQ por conexión directa', () => {
    expect(evaluateNetwork({ remoteAddress: '10.20.5.9' }, policy).decision).toBe('inside');
    expect(evaluateNetwork({ remoteAddress: '203.0.113.7' }, policy).decision).toBe('outside');
  });

  it('ignora X-Forwarded-For cuando la conexión no viene de un proxy confiable', () => {
    const evaluation = evaluateNetwork(
      { remoteAddress: '203.0.113.7', forwardedFor: '10.20.5.9' },
      policy,
    );

    expect(evaluation.decision).toBe('outside');
    expect(evaluation.clientIp).toBe('203.0.113.7');
  });

  it('toma el último salto no confiable como cliente, no el primero declarado', () => {
    const evaluation = evaluateNetwork(
      { remoteAddress: '172.31.0.5', forwardedFor: '10.20.5.9, 203.0.113.7, 172.31.0.5' },
      policy,
    );

    expect(evaluation.clientIp).toBe('203.0.113.7');
    expect(evaluation.decision).toBe('outside');
  });

  it('acepta el cliente interno cuando la cadena completa es confiable hasta él', () => {
    const evaluation = evaluateNetwork(
      { remoteAddress: '172.31.0.5', forwardedFor: '10.20.5.9, 172.31.0.5' },
      policy,
    );

    expect(evaluation).toMatchObject({ decision: 'inside', clientIp: '10.20.5.9' });
  });

  it('marca la cadena como no confiable ante un salto ilegible', () => {
    expect(
      evaluateNetwork(
        { remoteAddress: '172.31.0.5', forwardedFor: 'no-es-una-ip, 172.31.0.5' },
        policy,
      ).decision,
    ).toBe('untrusted_chain');
  });

  it('marca la cadena como no confiable si todos los saltos son proxies', () => {
    expect(
      evaluateNetwork(
        { remoteAddress: '172.31.0.5', forwardedFor: '172.31.0.9, 172.31.0.5' },
        policy,
      ).decision,
    ).toBe('untrusted_chain');
  });
});

describe('C-25 · Smart Lockout', () => {
  it('permite intentos hasta el umbral del origen desconocido', () => {
    let counter = emptyCounter('subject-1', '203.0.113.7', NOW);
    for (let attempt = 1; attempt < LOCKOUT_POLICY.unfamiliarThreshold; attempt += 1) {
      counter = registerFailure(counter, NOW);
      expect(evaluateLockout(counter, NOW).allowed).toBe(true);
    }
    counter = registerFailure(counter, NOW);

    expect(evaluateLockout(counter, NOW).allowed).toBe(false);
  });

  it('tolera más intentos desde un origen ya familiar', () => {
    let counter = registerSuccess(emptyCounter('subject-1', '10.20.5.9', NOW), NOW);
    for (let attempt = 0; attempt < LOCKOUT_POLICY.unfamiliarThreshold + 1; attempt += 1) {
      counter = registerFailure(counter, NOW);
    }

    expect(evaluateLockout(counter, NOW).allowed).toBe(true);
  });

  it('alarga el bloqueo en cada reincidencia hasta el tope', () => {
    let counter = emptyCounter('subject-1', '203.0.113.7', NOW);
    const durations: number[] = [];
    let at = NOW;
    for (let round = 0; round < 8; round += 1) {
      for (let attempt = 0; attempt < LOCKOUT_POLICY.unfamiliarThreshold; attempt += 1) {
        counter = registerFailure(counter, at);
      }
      const decision = evaluateLockout(counter, at);
      if (!decision.allowed) durations.push(decision.retryAfterMs);
      at = new Date(counter.lockedUntil!.getTime() + 1);
    }

    expect(durations[1]).toBeGreaterThan(durations[0]!);
    expect(Math.max(...durations)).toBeLessThanOrEqual(LOCKOUT_POLICY.maximumLockoutMs);
  });

  it('vuelve a permitir cuando el bloqueo expira', () => {
    let counter = emptyCounter('subject-1', '203.0.113.7', NOW);
    for (let attempt = 0; attempt < LOCKOUT_POLICY.unfamiliarThreshold; attempt += 1) {
      counter = registerFailure(counter, NOW);
    }
    const after = new Date(counter.lockedUntil!.getTime() + 1);

    expect(evaluateLockout(counter, after).allowed).toBe(true);
  });

  it('olvida los fallos cuando la ventana pasa sin alcanzar el umbral', () => {
    let counter = emptyCounter('subject-1', '203.0.113.7', NOW);
    counter = registerFailure(counter, NOW);
    counter = registerFailure(counter, NOW);
    const after = new Date(NOW.getTime() + LOCKOUT_POLICY.windowMs + 1);
    const decision = evaluateLockout(counter, after);

    expect(decision.allowed && decision.remainingAttempts).toBe(LOCKOUT_POLICY.unfamiliarThreshold);
  });

  it('cuenta por sujeto y origen, de modo que un atacante remoto no bloquea la oficina', () => {
    let remote = emptyCounter('subject-1', '203.0.113.7', NOW);
    for (let attempt = 0; attempt < LOCKOUT_POLICY.unfamiliarThreshold; attempt += 1) {
      remote = registerFailure(remote, NOW);
    }
    const office = emptyCounter('subject-1', '10.20.5.9', NOW);

    expect(evaluateLockout(remote, NOW).allowed).toBe(false);
    expect(evaluateLockout(office, NOW).allowed).toBe(true);
  });
});

describe('C-25 · limitación de tasa', () => {
  it('corta al superar el máximo por ventana y se reabre después', () => {
    let state = consumeRateLimit(undefined, 'ip:203.0.113.7', NOW).state;
    for (let request = 1; request < RATE_LIMIT_POLICY.maxRequests; request += 1) {
      const decision = consumeRateLimit(state, 'ip:203.0.113.7', NOW);
      expect(decision.allowed).toBe(true);
      state = decision.state;
    }
    const blocked = consumeRateLimit(state, 'ip:203.0.113.7', NOW);
    const reopened = consumeRateLimit(
      state,
      'ip:203.0.113.7',
      new Date(NOW.getTime() + RATE_LIMIT_POLICY.windowMs),
    );

    expect(blocked.allowed).toBe(false);
    expect(!blocked.allowed && blocked.retryAfterMs).toBeGreaterThan(0);
    expect(reopened.allowed).toBe(true);
  });
});

describe('C-25 · política de admisión', () => {
  it('exige passkey fuera de la red y acepta MFA dentro', () => {
    expect(policyForNetwork('inside')?.requiredAmr).toContain('mfa');
    expect(policyForNetwork('outside')?.requiredAmr).toEqual(['fido', 'hwk', 'phr']);
    expect(policyForNetwork('untrusted_chain')).toBeUndefined();
  });

  it('admite al analista con MFA desde dentro', () => {
    const decision = decideSignIn({
      network: 'inside',
      locked: false,
      rateLimited: false,
      claims: baseClaims(NOW),
      roles: ['qapaq.soc.analyst'],
      capabilities: new Set(['alerts.read']),
    });

    expect(decision.admitted).toBe(true);
  });

  it('deniega desde fuera sin passkey y admite con passkey', () => {
    const base = {
      network: 'outside' as const,
      locked: false,
      rateLimited: false,
      roles: ['qapaq.soc.analyst'],
      capabilities: new Set(['alerts.read']),
    };

    expect(decideSignIn({ ...base, claims: baseClaims(NOW) })).toMatchObject({
      admitted: false,
      reason: 'PASSKEY_REQUIRED',
    });
    expect(decideSignIn({ ...base, claims: baseClaims(NOW, { amr: ['fido'] }) }).admitted).toBe(
      true,
    );
  });

  it('rechaza una petición cuyo origen no se puede afirmar', () => {
    expect(
      decideSignIn({
        network: 'untrusted_chain',
        locked: false,
        rateLimited: false,
        claims: baseClaims(NOW, { amr: ['fido'] }),
        roles: [],
        capabilities: new Set(['alerts.read']),
      }),
    ).toMatchObject({ admitted: false, reason: 'NETWORK_UNTRUSTED' });
  });

  it('no permite distinguir cuenta inexistente, bloqueada o sin rol por el mensaje', () => {
    const shared = { network: 'inside' as const, rateLimited: false, roles: [] };
    const messages = [
      decideSignIn({ ...shared, locked: true, capabilities: new Set(['alerts.read']) }),
      decideSignIn({ ...shared, locked: false, capabilities: new Set(['alerts.read']) }),
      decideSignIn({
        ...shared,
        locked: false,
        claims: baseClaims(NOW),
        capabilities: new Set<string>(),
      }),
    ].map((decision) => (decision.admitted ? 'ADMITIDO' : decision.publicMessage));

    expect(new Set(messages).size).toBe(1);
  });
});
