import React, { useState } from 'react';
import { discoverUrlForQuery, ServiceAttention, ServiceId, TopEvent } from '../../common';
import { DataZone, Timestamp } from './primitives';

const GROUPS: Partial<Record<ServiceId, string>> = {
  office365: 'office365',
  sharepoint: 'qapaq_sharepoint',
  aws: 'aws',
  cloudflare: 'cloudflare',
  bitdefender: 'bitdefender',
  snyk: 'snyk',
};

export function attentionQuery(service: ServiceId, criticalOnly: boolean): string {
  return `rule.level >= ${criticalOnly ? 12 : 8}${GROUPS[service] ? ` and rule.groups: "${GROUPS[service]}"` : ''}`;
}

export function filterAttention(events: readonly TopEvent[], criticalOnly: boolean, query: string) {
  const term = query.trim().toLocaleLowerCase();
  return events.filter(
    (event) =>
      (!criticalOnly || event.level >= 12) &&
      `${event.description} ${event.ruleId} ${event.agent ?? ''}`
        .toLocaleLowerCase()
        .includes(term),
  );
}

export function ServiceAttentionList({
  service,
  name,
  data,
  basePath,
}: {
  service: ServiceId;
  name: string;
  data?: ServiceAttention;
  basePath: string;
}) {
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [query, setQuery] = useState('');
  const events = filterAttention(data?.events ?? [], criticalOnly, query);
  const allHref = discoverUrlForQuery(
    basePath,
    attentionQuery(service, criticalOnly),
    'now-24h',
    'now',
  );
  return (
    <section className="qapaqAttention" aria-label={`Atención prioritaria: ${name}`}>
      <header>
        <strong>Atención prioritaria</strong>
        <span>24 h · críticas primero</span>
      </header>
      {!data || data.access !== 'ok' ? (
        <p role="status">
          {data?.access === 'forbidden'
            ? 'Sin permiso para consultar estos eventos.'
            : 'Lista no disponible. Actualiza el resumen para reintentar.'}
        </p>
      ) : (
        <>
          <div className="qapaqAttention__controls">
            <label>
              <input
                type="checkbox"
                checked={criticalOnly}
                onChange={(e) => setCriticalOnly(e.target.checked)}
              />{' '}
              Solo críticas (nivel ≥ 12)
            </label>
            <input
              type="search"
              aria-label={`Buscar en eventos visibles de ${name}`}
              placeholder="Buscar título, regla o equipo"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <p className="qapaqAttention__scope">
            {events.length} visibles · {data.total} altas y críticas.
            {(data.total ?? 0) > data.events.length &&
              ' Vista limitada a los 100 eventos de mayor severidad; abre la lista completa para revisar el resto.'}
          </p>
          {events.length === 0 ? (
            <p>
              {data.total === 0
                ? 'Sin eventos altos o críticos en esta ventana.'
                : 'Sin coincidencias en los eventos cargados.'}
            </p>
          ) : (
            <ol className="qapaqAttention__list" tabIndex={0} aria-label={`Eventos de ${name}`}>
              {events.map((event) => (
                <li key={event.id}>
                  <div className="qapaqAttention__row">
                    <span className="qapaqAttention__severity" data-critical={event.level >= 12}>
                      {event.level >= 12 ? 'Crítica' : 'Alta'} · {event.level}
                    </span>
                    <Timestamp iso={event.at || null} />
                  </div>
                  <DataZone>
                    <strong>{event.description}</strong>
                  </DataZone>
                  <div className="qapaqAttention__row">
                    Regla {event.ruleId} ·{' '}
                    <DataZone>{event.agent ?? 'Equipo no informado'}</DataZone>
                  </div>
                  <a
                    href={discoverUrlForQuery(
                      basePath,
                      `_id: ${JSON.stringify(event.id)}`,
                      'now-24h',
                      'now',
                    )}
                  >
                    Investigar evento →
                  </a>
                </li>
              ))}
            </ol>
          )}
          <a className="qapaqAttention__all" href={allHref}>
            Ver todos los eventos {criticalOnly ? 'críticos' : 'altos y críticos'} →
          </a>
          <small>
            Severidad del SIEM; el estado de respuesta se gestiona en la cola QAPAQ. Las fuentes
            pueden compartir eventos.
          </small>
        </>
      )}
    </section>
  );
}
