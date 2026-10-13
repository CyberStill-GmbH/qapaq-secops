/**
 * Sprint 5 · fase 0 — composición de la ingesta desde el Indexer de Wazuh.
 *
 * Es el único lugar del API que nombra a Wazuh para la ingesta (regla C-23): une el proveedor
 * de C-28, la normalización de C-12 y la pasada genérica de `ingestion-poller.ts`.
 *
 * Identidad estable de cada documento: la normalización deriva `recordId` de la huella del
 * crudo y de `receivedAt`. En la lectura directa se usa como `receivedAt` la hora del propio
 * documento (`timestamp`), que no cambia entre lecturas; así releer el solape produce el mismo
 * `recordId` y la promoción reconoce el duplicado. La huella es SHA-256 del JSON canónico
 * (claves ordenadas), independiente del orden en que el Indexer serialice los campos.
 *
 * `raw.ref` apunta al documento en el Indexer (`raw:wazuh/<dataset>/<id>`): en el demo no hay
 * custodia propia de crudos (C-04/MinIO), y Wazuh sigue siendo el dueño del dato.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  createWazuhSecurityEventProvider,
  type ProviderRecord,
  type SecurityEventProvider,
} from '@qapaq/connectors';
import { normalizeWazuhAlert } from '@qapaq/telemetry/wazuh';

import { createEventsReader, type EventsReader } from './events-reader.js';
import { createIngestionPass, type RecordConversion } from './ingestion-poller.js';
import { compileWazuhEventFilters } from './wazuh-event-filters.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import type { SecOpsRuntime } from './secops-runtime.js';

export const WAZUH_DATASET = 'wazuh-alerts';
/**
 * Campo del documento Wazuh con la suscripción de Office 365 que originó el registro, y las
 * suscripciones que el módulo `office365` de Wazuh recolecta (ossec-office365.xml.tmpl).
 */
export const OFFICE365_SUBSCRIPTION_FIELD = 'data.office365.Subscription';
export const OFFICE365_SUBSCRIPTIONS = Object.freeze([
  'Audit.AzureActiveDirectory',
  'Audit.Exchange',
  'Audit.General',
  'Audit.SharePoint',
]);
const DATASET = WAZUH_DATASET;
const CONNECTOR_VERSION = '1.0.0';
/** Ventana de lectura (ver `IngestionWindowPolicy`). */
const WINDOW = Object.freeze({
  lagMs: 30_000,
  overlapMs: 120_000,
  maximumWindowMs: 3_600_000,
});
const PAGE_SIZE = 50;
const MAXIMUM_PAGES = 20;
/** Lease del cursor: cubre una pasada completa (20 páginas con reintentos) con margen. */
const LEASE_MS = 5 * 60_000;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/** Convierte un documento del Indexer en `SecurityEvent`, o lo marca en cuarentena. */
export function wazuhRecordToEvent(
  record: ProviderRecord,
  tenantId: string,
  instanceId: string,
): RecordConversion {
  const occurredAt = record.occurredAt ? new Date(record.occurredAt) : undefined;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return { status: 'quarantined' };
  const body = canonical(record.raw);
  const outcome = normalizeWazuhAlert(
    {
      record: {
        sourceRecordId: record.sourceRecordId,
        dataset: record.dataset,
        collectedAt: record.collectedAt,
        raw: record.raw,
      },
      raw: {
        ref: `raw:wazuh/${record.dataset}/${record.sourceRecordId}`,
        sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        mediaType: 'application/json',
        sizeBytes: Buffer.byteLength(body, 'utf8'),
      },
    },
    {
      tenantId,
      instanceId,
      connector: 'wazuh',
      connectorVersion: CONNECTOR_VERSION,
      receivedAt: occurredAt,
    },
  );
  return outcome.status === 'normalized'
    ? { status: 'normalized', event: outcome.event }
    : { status: 'quarantined' };
}

/**
 * Proveedor de C-28 compartido por la ingesta y el explorador de eventos: un solo cliente, un
 * solo token de workload y el mismo compilador de filtros.
 */
export function createWazuhEventProvider(options: {
  readonly sourceId: string;
  readonly gatewayBaseUrl: string;
  readonly accessToken: () => Promise<string>;
}): SecurityEventProvider {
  return createWazuhSecurityEventProvider({
    sourceId: options.sourceId,
    gateway: {
      baseUrl: options.gatewayBaseUrl,
      accessToken: options.accessToken,
      requestTimeoutMs: 15_000,
      maximumPageSize: 200,
      retryLimit: 3,
      dataset: DATASET,
      // Los cursores viven dentro de una pasada o de una sesión de exploración corta: una
      // clave efímera por proceso basta y no hay secreto que administrar.
      cursorSigningKey: randomBytes(32).toString('hex'),
      cursorTtlMs: 10 * 60_000,
      maximumResponseBytes: 10 * 1024 * 1024,
      allowPrivateServiceHttp: true,
    },
    compileFilters: compileWazuhEventFilters,
    activityField: OFFICE365_SUBSCRIPTION_FIELD,
  });
}

/** Lector del explorador: el mismo proveedor, normalización con la identidad estable. */
export function createWazuhEventsReader(options: {
  readonly provider: SecurityEventProvider;
  readonly tenantId: string;
  readonly sourceId: string;
}): EventsReader {
  return createEventsReader({
    provider: options.provider,
    sourceId: options.sourceId,
    dataset: DATASET,
    toEvent: (record) => wazuhRecordToEvent(record, options.tenantId, options.sourceId),
  });
}

export interface WazuhIngestionOptions {
  readonly runtime: SecOpsRuntime;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly intervalMs: number;
  readonly initialLookbackMs: number;
  readonly onError: (error: unknown) => void;
  /** Proveedor compartido con el explorador (`createWazuhEventProvider`); en pruebas, uno falso. */
  readonly provider: SecurityEventProvider;
  /** Al terminar cada pasada (fase 2: registrar la salud de la fuente). */
  readonly afterPass?: () => Promise<void>;
}

/** Bucle de ingesta listo para `start`/`stop`; reutiliza el motor del despachador. */
export function createWazuhIngestion(options: WazuhIngestionOptions): NotificationDispatcher {
  const provider = options.provider;
  const pass = createIngestionPass({
    key: { tenantId: options.tenantId, sourceId: options.sourceId, dataset: DATASET },
    readPage: (query) => provider.readPage(query),
    state: options.runtime.soc.ingestion,
    toEvent: (record) => wazuhRecordToEvent(record, options.tenantId, options.sourceId),
    promote: (event) => options.runtime.promoteEvent(event),
    window: { ...WINDOW, initialLookbackMs: options.initialLookbackMs },
    pageSize: PAGE_SIZE,
    maximumPages: MAXIMUM_PAGES,
    leaseMs: LEASE_MS,
    now: () => options.runtime.now(),
    ...(options.afterPass ? { afterPass: options.afterPass } : {}),
  });
  return new NotificationDispatcher({
    drain: pass,
    intervalMs: options.intervalMs,
    onError: options.onError,
  });
}
