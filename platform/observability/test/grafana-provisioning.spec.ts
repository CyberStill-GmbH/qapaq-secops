import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALERT_RULES,
  BACKUP_RECOVERY_PLAN,
  buildDashboards,
  EXTERNAL_RECEIVER,
  GRAFANA_HARDENING,
  PROMETHEUS_UID,
  RETENTION_POLICIES,
  serializeDashboard,
} from '../src/grafana-provisioning.js';
import { SOC_METRICS, validateSocMetrics } from '../src/soc-signals.js';

const GRAFANA = resolve(import.meta.dirname, '../grafana');

function read(relative: string): string {
  return readFileSync(resolve(GRAFANA, relative), 'utf8');
}

describe('C-26 · catálogo de señales SOC', () => {
  it('respeta la allowlist de etiquetas y el presupuesto de cardinalidad', () => {
    const validation = validateSocMetrics();

    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('cubre alerta, triaje, incidente, notificación, acceso y auditoría', () => {
    const names = SOC_METRICS.map((metric) => metric.name);

    for (const expected of [
      'qapaq_soc_alerts_total',
      'qapaq_soc_triage_seconds',
      'qapaq_soc_incidents_open',
      'qapaq_soar_notifications_total',
      'qapaq_access_sign_in_total',
      'qapaq_audit_chain_verifications_total',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('no declara ninguna etiqueta que identifique a una persona o a un recurso', () => {
    const labels = SOC_METRICS.flatMap((metric) => metric.labels);

    expect(labels).not.toContain('user' as never);
    expect(labels.some((label) => /id$|ip|principal|host/u.test(label))).toBe(false);
  });
});

describe('C-26 · dashboards versionados', () => {
  it('lo versionado coincide con lo generado desde el catálogo', () => {
    for (const dashboard of buildDashboards()) {
      expect(read(`dashboards/${dashboard.uid}.json`)).toBe(serializeDashboard(dashboard));
    }
  });

  it('cada panel apunta a un origen de datos declarado', () => {
    for (const dashboard of buildDashboards()) {
      expect(dashboard.panels.length).toBeGreaterThan(0);
      for (const panel of dashboard.panels) {
        expect(panel.datasource.uid).toBe(PROMETHEUS_UID);
        expect(panel.targets[0]?.expr).toContain('qapaq_');
      }
    }
  });

  it('cada panel consulta una métrica que el catálogo emite', () => {
    const names = SOC_METRICS.map((metric) => metric.name);

    for (const dashboard of buildDashboards()) {
      for (const panel of dashboard.panels) {
        expect(names.some((name) => panel.targets[0]?.expr.includes(name))).toBe(true);
      }
    }
  });
});

describe('C-26 · alertas', () => {
  it('cubre crítico sin entregar, P1 sin triar y cadena comprometida', () => {
    const titles = ALERT_RULES.map((rule) => rule.uid);

    expect(titles).toContain('qapaq-critical-notification-failed');
    expect(titles).toContain('qapaq-p1-untriaged');
    expect(titles).toContain('qapaq-audit-chain-broken');
  });

  it('envía todas las reglas a un destino externo al propio stack', () => {
    expect(ALERT_RULES.every((rule) => rule.receiver === EXTERNAL_RECEIVER)).toBe(true);
    expect(read('provisioning/alerting/qapaq-contact-points.yaml')).toContain(EXTERNAL_RECEIVER);
  });

  it('no versiona el secreto del destino', () => {
    const contactPoints = read('provisioning/alerting/qapaq-contact-points.yaml');

    expect(contactPoints).toContain('$QAPAQ_ONCALL_WEBHOOK_URL');
    expect(contactPoints).not.toMatch(/https:\/\/[^\s$]+\.(?:com|pe|net)/u);
  });
});

describe('C-26 · hardening, retención y recuperación', () => {
  it('aplica cada control declarado en grafana.ini', () => {
    const ini = read('grafana.ini');

    for (const check of GRAFANA_HARDENING) {
      const setting = check.settingPath.split('.').at(-1)!;
      const match = new RegExp(`^${setting}\\s*=\\s*(.+)$`, 'mu').exec(ini);

      expect(match, `ajuste ausente: ${check.settingPath}`).not.toBeNull();
      expect(match?.[1]?.trim(), check.requirement).toBe(check.expected);
    }
  });

  it('no deja acceso anónimo ni autorregistro', () => {
    const ini = read('grafana.ini');

    expect(ini).toMatch(/\[auth\.anonymous\][\s\S]*?enabled\s*=\s*false/u);
    expect(ini).toMatch(/allow_sign_up\s*=\s*false/u);
    expect(ini).toMatch(/reporting_enabled\s*=\s*false/u);
  });

  it('declara orígenes de datos no editables y por proxy', () => {
    const datasources = read('provisioning/datasources/qapaq.yaml');

    expect(datasources).toContain('access: proxy');
    expect(datasources).toContain('editable: false');
    expect(datasources).toContain('.qapaq.internal');
    expect(datasources).not.toMatch(/password|basicAuth/u);
  });

  it('impide que una edición en la interfaz se convierta en la fuente', () => {
    const provider = read('provisioning/dashboards/qapaq.yaml');

    expect(provider).toContain('allowUiUpdates: false');
    expect(provider).toContain('disableDeletion: true');
  });

  it('declara retención con justificación para cada señal', () => {
    expect(RETENTION_POLICIES.map((policy) => policy.signal).sort()).toEqual([
      'logs',
      'metrics',
      'traces',
    ]);
    for (const policy of RETENTION_POLICIES) {
      expect(policy.retentionDays).toBeGreaterThan(0);
      expect(policy.justification.length).toBeGreaterThan(10);
    }
  });

  it('define un plan de restauración con verificación por paso', () => {
    expect(BACKUP_RECOVERY_PLAN).toHaveLength(4);
    expect(BACKUP_RECOVERY_PLAN.map((step) => step.order)).toEqual([1, 2, 3, 4]);
    for (const step of BACKUP_RECOVERY_PLAN) {
      expect(step.verification.length).toBeGreaterThan(10);
    }
  });
});
