import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * C-17/C-19/C-20 — contrato de la migración de operación SOC.
 *
 * Verifica sobre el SQL lo que el dominio asume y no puede imponer por sí solo:
 * append-only real de auditoría, unicidad que sostiene la idempotencia y CHECKs que
 * impiden estados imposibles aunque un adapter tenga un error.
 */

const migrationPath = new URL(
  '../prisma/migrations/20261008120000_c17_c19_c20_soc_operations/migration.sql',
  import.meta.url,
);

const sql = await readFile(migrationPath, 'utf8');

describe('C-19 · auditoría append-only en la base', () => {
  it('crea la tabla con su cadena de hash y secuencia por tenant', () => {
    expect(sql).toContain('CREATE TABLE "audit_events"');
    expect(sql).toContain('CREATE UNIQUE INDEX "audit_events_tenant_sequence_key"');
    expect(sql).toMatch(/"hash" ~ '\^\[0-9a-f\]\{64\}\$'/u);
    expect(sql).toMatch(/"previous_hash" ~ '\^\[0-9a-f\]\{64\}\$'/u);
  });

  it('rechaza UPDATE, DELETE y TRUNCATE con triggers, no solo con privilegios', () => {
    for (const trigger of [
      'audit_events_no_update',
      'audit_events_no_delete',
      'audit_events_no_truncate',
    ]) {
      expect(sql, `falta el trigger ${trigger}`).toContain(trigger);
    }
    expect(sql).toContain('RAISE EXCEPTION');
  });

  it('impide que la auditoría se borre en cascada desde otra tabla', () => {
    expect(sql).not.toContain('ON DELETE CASCADE');
  });
});

describe('C-16/C-17 · integridad del flujo SOC', () => {
  it('impone la idempotencia de la promoción en la base', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "detection_candidates_idempotency_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "soc_alerts_candidate_key"');
  });

  it('acota estados, prioridades y veredictos a los catálogos del dominio', () => {
    expect(sql).toMatch(
      /soc_alerts_status_allowed[\s\S]*?'new', 'acknowledged', 'triaged', 'escalated', 'closed'/u,
    );
    expect(sql).toMatch(
      /soc_incidents_status_allowed[\s\S]*?'open', 'contained', 'eradicated', 'resolved', 'closed'/u,
    );
    expect(sql).toMatch(/soc_alerts_verdict_allowed/u);
    expect(sql).toMatch(/detection_candidates_score_range[\s\S]*?BETWEEN 0 AND 100/u);
  });

  it('impide estados incompletos que el dominio considera imposibles', () => {
    expect(sql).toContain('soc_alerts_triage_complete');
    expect(sql).toContain('soc_incidents_closure_complete');
    expect(sql).toContain('notification_attempts_ack_has_actor');
    expect(sql).toContain('notification_attempts_sent_has_time');
  });

  it('mantiene las relaciones con RESTRICT', () => {
    const foreignKeys = [...sql.matchAll(/ADD CONSTRAINT "([^"]+_fkey)"/gu)].map(
      (match) => match[1],
    );

    expect(foreignKeys).toEqual(['soc_alerts_candidate_fkey', 'soc_alerts_incident_fkey']);
    expect((sql.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/gu) ?? []).length).toBe(
      foreignKeys.length,
    );
  });
});

describe('C-20 · intentos de notificación', () => {
  it('impone un único intento vivo por mensaje de outbox', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "notification_attempts_idempotency_key"');
  });

  it('acota canales y estados declarados por el dominio', () => {
    expect(sql).toMatch(
      /notification_attempts_channel_allowed[\s\S]*?'teams', 'fallback_email', 'manual_console'/u,
    );
    expect(sql).toMatch(/notification_attempts_status_allowed/u);
  });
});

describe('contrato general de la migración', () => {
  it('es transaccional de extremo a extremo', () => {
    // La cabecera es un comentario; lo que importa es que nada se cree fuera de la
    // transacción y que el cierre sea el último enunciado.
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf('CREATE TABLE'));
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('crea exactamente las tablas de esta entrega', () => {
    const tables = [...sql.matchAll(/CREATE TABLE "([^"]+)"/gu)].map((match) => match[1]);

    expect(tables).toEqual([
      'audit_events',
      'detection_candidates',
      'soc_incidents',
      'soc_alerts',
      'notification_attempts',
    ]);
  });

  it('no incrusta identificadores ni valores de ejemplo', () => {
    expect(sql).not.toMatch(/INSERT INTO/u);
    expect(sql).not.toMatch(/password|secret|token/iu);
  });
});
