/**
 * Emisor local de desarrollo: el `oid` de sus personas sintéticas debe poder guardarse en una
 * sesión durable. `access_sessions.subject_oid` tiene un CHECK con el formato GUID de Entra
 * (migración 20261013150000_s5_session_oid); un `oid` libre rompía el login local con
 * `QAPAQ_SOC_PERSISTENCE=postgres`.
 */

import { describe, expect, it } from 'vitest';

import { LOCAL_PRINCIPALS, LocalDevelopmentIssuer } from '../src/access/local-issuer.js';

/** Mismo patrón que el CHECK `access_sessions_subject_oid_format`. */
const SUBJECT_OID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe('LocalDevelopmentIssuer', () => {
  const issuer = new LocalDevelopmentIssuer({
    issuer: 'https://login.example/local/v2.0',
    audience: 'qapaq-secops-local',
    tenantId: 'local-development',
    profile: 'development',
  });

  it.each(Object.values(LOCAL_PRINCIPALS))('$username firma un oid GUID único', (principal) => {
    const token = issuer.sign(principal, 'nonce', new Date('2026-11-03T00:00:00Z'));
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(claims.oid).toMatch(SUBJECT_OID_FORMAT);
    expect(claims.sub).toBe(principal.subjectId);
    const owners = Object.values(LOCAL_PRINCIPALS).filter((p) => p.objectId === claims.oid);
    expect(owners).toHaveLength(1);
  });
});
