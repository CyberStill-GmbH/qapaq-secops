/**
 * Sonda de demostración de C-12.
 *
 * Ejecuta el normalizador REAL (`modules/telemetry/src/wazuh-normalization.ts`) sobre un
 * lote de alertas Wazuh y escribe el resultado en JSON. No simula nada: el mismo código
 * que corre en las pruebas es el que produce esta salida, y las huellas `sha256` de cada
 * documento crudo se calculan de verdad.
 *
 * Uso:  npx tsx scripts/demo/c12-normalization-demo.ts
 * Salida: output/demo/c12-normalization-run.json
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  normalizeWazuhPage,
  WAZUH_MAPPING_ID,
  WAZUH_MAPPING_VERSION,
  type WazuhAlertInput,
  type WazuhNormalizationContext,
} from '../../modules/telemetry/src/wazuh-normalization.js';

const RECEIVED_AT = new Date('2026-09-30T16:45:00.000Z');

const context: WazuhNormalizationContext = {
  tenantId: 'tenant-qapaq-001',
  instanceId: 'siem-qapaq-lab',
  connector: 'qapaq-wazuh-indexer',
  connectorVersion: '1.0.0',
  receivedAt: RECEIVED_AT,
};

/** Lote representativo: ocho alertas bien formadas y dos corruptas, a propósito. */
const ALERTS: readonly { readonly id: string; readonly raw: Record<string, unknown> }[] = [
  {
    id: 'evt-1001',
    raw: {
      timestamp: '2026-09-30T16:41:02.000Z',
      rule: {
        id: 5716,
        level: 10,
        description: 'Intento de autenticación SSH fallido',
        groups: ['sshd', 'authentication_failed'],
      },
      agent: { id: '003', name: 'srv-app-01.qapaq.local' },
      data: { srcuser: 'jperez@qapaq.pe', srcip: '190.12.44.7' },
    },
  },
  {
    id: 'evt-1002',
    raw: {
      timestamp: '2026-09-30T16:41:37.000Z',
      rule: {
        id: 87321,
        level: 13,
        description: 'Archivo malicioso detectado por análisis antivirus',
        groups: ['virus', 'malware'],
      },
      agent: { id: '007', name: 'workstation-contabilidad.qapaq.local' },
      data: { srcuser: 'mquispe@qapaq.pe' },
    },
  },
  {
    id: 'evt-1003',
    raw: {
      timestamp: '2026-09-30T16:42:10.000Z',
      rule: {
        id: 550,
        level: 7,
        description: 'Integridad de archivo alterada en directorio vigilado',
        groups: ['syscheck', 'syscheck_entry_added'],
      },
      agent: { id: '003', name: 'srv-app-01.qapaq.local' },
      data: {},
    },
  },
  {
    id: 'evt-1004',
    raw: {
      timestamp: '2026-09-30T16:42:55.000Z',
      rule: {
        id: 91533,
        level: 5,
        description: 'Inicio de sesión correcto en Microsoft 365',
        groups: ['office365', 'authentication_success'],
      },
      agent: { id: '000', name: 'wazuh-manager' },
      data: { office365: { UserId: 'fclavo@qapaq.pe' } },
    },
  },
  {
    id: 'evt-1005',
    raw: {
      // Marca temporal imposible: el 31 de febrero no existe.
      timestamp: '2026-02-31T16:43:00.000Z',
      rule: { id: 1002, level: 6, description: 'Evento con fecha corrupta', groups: ['syslog'] },
      agent: { id: '004', name: 'srv-web-02.qapaq.local' },
    },
  },
  {
    id: 'evt-1006',
    raw: {
      timestamp: '2026-09-30T16:43:21.000Z',
      rule: {
        id: 4151,
        level: 3,
        description: 'Conexión rechazada por el cortafuegos perimetral',
        groups: ['firewall'],
      },
      agent: { id: '001', name: 'fw-perimetral.qapaq.local' },
      data: { srcip: '45.133.1.90' },
    },
  },
  {
    id: 'evt-1007',
    raw: {
      timestamp: '2026-09-30T16:43:58.000Z',
      rule: {
        id: 31151,
        level: 9,
        description: 'Múltiples solicitudes web sospechosas desde un mismo origen',
        groups: ['web', 'web_scan'],
      },
      agent: { id: '004', name: 'srv-web-02.qapaq.local' },
      data: { srcip: '45.133.1.90' },
    },
  },
  {
    id: 'evt-1008',
    raw: {
      // Alerta sin regla: no se puede sostener qué la originó.
      timestamp: '2026-09-30T16:44:12.000Z',
      agent: { id: '005', name: 'srv-bd-01.qapaq.local' },
      data: { srcuser: 'root' },
    },
  },
  {
    id: 'evt-1009',
    raw: {
      timestamp: '2026-09-30T16:44:30.000Z',
      rule: {
        id: 60122,
        level: 12,
        description: 'Cuenta de administrador agregada al dominio',
        groups: ['windows', 'account_changed', 'adduser'],
      },
      agent: { id: '002', name: 'dc-01.qapaq.local' },
      data: { dstuser: 'svc_backup@qapaq.pe' },
    },
  },
  {
    id: 'evt-1010',
    raw: {
      timestamp: '2026-09-30T16:44:51.000Z',
      rule: {
        id: 19003,
        level: 2,
        description: 'Rotación programada de registros completada',
        groups: ['syslog'],
      },
      agent: { id: '003', name: 'srv-app-01.qapaq.local' },
    },
  },
];

function toInput(alert: (typeof ALERTS)[number]): WazuhAlertInput {
  const bytes = Buffer.from(JSON.stringify(alert.raw), 'utf8');
  return {
    record: {
      sourceRecordId: alert.id,
      dataset: 'alerts',
      collectedAt: '2026-09-30T16:45:00.000Z',
      raw: alert.raw,
    },
    raw: {
      ref: `raw:tenant-qapaq-001/2026/09/30/${alert.id}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'application/json',
      sizeBytes: bytes.byteLength,
    },
  };
}

const inputs = ALERTS.map(toInput);
const startedAt = Date.now();
const result = normalizeWazuhPage(inputs, context);
const elapsedMs = Date.now() - startedAt;

const report = {
  component: 'C-12',
  title: 'Normalización de alertas Wazuh al contrato SecurityEvent',
  generatedAt: new Date().toISOString(),
  mappingId: WAZUH_MAPPING_ID,
  mappingVersion: WAZUH_MAPPING_VERSION,
  elapsedMs,
  counts: result.counts,
  lossless: result.counts.normalized + result.counts.quarantined === result.counts.received,
  normalized: result.normalized.map((event) => ({
    recordId: event.recordId,
    eventUid: event.eventUid,
    occurredAt: event.occurredAt,
    severity: event.severity.normalized,
    score: event.severity.score ?? null,
    originalLevel: event.severity.originalValue,
    category: event.category,
    outcome: event.outcome,
    rule: event.detection?.rule.name ?? null,
    host: event.entities.resources[0]?.name ?? null,
    principal: event.entities.identities[0]?.principal ?? null,
    rawRef: event.raw.ref,
    mappingVersion: event.provenance.mappingVersion,
  })),
  quarantined: result.quarantined.map((item) => ({
    sourceRecordId: item.sourceRecordId,
    code: item.reason.code,
    message: item.reason.message,
    path: item.reason.path,
    rawRef: item.rawRef,
    rawSha256: item.rawSha256,
  })),
  rawSamples: Object.fromEntries(
    inputs.map((input) => [input.record.sourceRecordId, input.record.raw]),
  ),
};

const target = resolve(process.cwd(), 'output/demo/c12-normalization-run.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(
  `C-12 demo: ${result.counts.received} recibidas, ${result.counts.normalized} normalizadas, ${result.counts.quarantined} en cuarentena`,
);
console.log(`Sin pérdida: ${report.lossless ? 'sí' : 'NO'}  ·  ${elapsedMs} ms`);
console.log(`Salida: ${target}`);
