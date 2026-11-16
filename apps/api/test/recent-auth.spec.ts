import { describe, expect, it } from 'vitest';

import { needsRecentAuth, RECENT_AUTH_MS } from '../src/soc/notification-channels.controller.js';

describe('sesión reciente (step-up) para configurar canales y el Analista IA', () => {
  const now = new Date('2026-11-15T20:00:00Z');
  const old = { createdAt: new Date(now.getTime() - RECENT_AUTH_MS - 1) };
  const fresh = { createdAt: new Date(now.getTime() - 60_000) };

  it('la administración de plataforma configura con su sesión vigente', () => {
    expect(needsRecentAuth({ roles: ['qapaq.platform.admin'] }, old, now)).toBe(false);
  });

  it('otros roles con permiso necesitan un inicio de sesión de menos de 30 min', () => {
    expect(needsRecentAuth({ roles: ['qapaq.soc.lead'] }, old, now)).toBe(true);
    expect(needsRecentAuth({ roles: ['qapaq.soc.lead'] }, fresh, now)).toBe(false);
  });
});
