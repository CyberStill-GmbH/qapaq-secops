/**
 * Política de ruido de avisos (`QAPAQ_NOTIFY_*`). Regresión 2026-11-13: el loader las leía pero no
 * estaban en KNOWN_QAPAQ_VARIABLES, así que definir cualquiera tumbaba el arranque del API.
 */

import { describe, expect, it } from 'vitest';

import { loadNotificationPolicy } from '../src/index.js';
import { rejectUnknownQapaqVariables } from '../src/schema/environment.schema.js';

const ALL = {
  QAPAQ_NOTIFY_QUIET_P1_MINUTES: '30',
  QAPAQ_NOTIFY_QUIET_P2_MINUTES: '120',
  QAPAQ_NOTIFY_STALE_MINUTES: '60',
  QAPAQ_NOTIFY_MAX_PER_HOUR: '12',
  QAPAQ_NOTIFY_DIGEST_MINUTES: '0',
  QAPAQ_NOTIFY_TIME_ZONE: 'America/Lima',
};

describe('QAPAQ_NOTIFY_*', () => {
  it('son variables conocidas', () => {
    expect(() => rejectUnknownQapaqVariables(ALL)).not.toThrow();
  });

  it('el resumen P3/P4 se apaga con 0', () => {
    expect(loadNotificationPolicy({ QAPAQ_PROFILE: 'production', QAPAQ_NOTIFY_DIGEST_MINUTES: '0' })).toMatchObject({
      digestMinutes: 0,
    });
  });
});
