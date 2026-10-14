/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  EuiBasicTable,
  EuiBasicTableColumn,
  EuiButton,
  EuiButtonEmpty,
  EuiCallOut,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSelect,
  EuiSpacer,
} from '@elastic/eui';
import {
  AUDIT_VIOLATION_LABEL,
  AuditEvent,
  AuditOutcome,
  AuditVerification,
  CAPABILITIES,
  Page,
  parseResource,
} from '../../common';
import { QapaqPage, useConsole } from './console_context';
import {
  DataZone,
  EmptyLine,
  ErrorCallout,
  HealthMark,
  Mono,
  Timestamp,
  useAsync,
} from './primitives';

const WINDOWS = [
  { value: '1', text: 'Últimas 24 h' },
  { value: '7', text: 'Últimos 7 días' },
  { value: '30', text: 'Últimos 30 días' },
  { value: '90', text: 'Últimos 90 días' },
];

const OUTCOME_LABEL: Record<AuditOutcome, string> = {
  allowed: 'Permitido',
  denied: 'Denegado',
  succeeded: 'Correcto',
  failed: 'Fallido',
};

const OUTCOME_TONE: Record<AuditOutcome, 'ok' | 'fail'> = {
  allowed: 'ok',
  succeeded: 'ok',
  denied: 'fail',
  failed: 'fail',
};

export function AuditView() {
  const { can } = useConsole();
  if (!can(CAPABILITIES.auditRead)) {
    return (
      <QapaqPage title="Auditoría e integridad">
        <EmptyLine>Tu rol no incluye la lectura de la auditoría.</EmptyLine>
      </QapaqPage>
    );
  }
  return <AuditContent />;
}

function AuditContent() {
  const { api, can } = useConsole();
  const [days, setDays] = useState('1');
  const [outcome, setOutcome] = useState<AuditOutcome | ''>('');
  const [actionInput, setActionInput] = useState('');
  const [action, setAction] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [actorId, setActorId] = useState('');
  const [resourceInput, setResourceInput] = useState('');
  const [resource, setResource] = useState('');
  const [items, setItems] = useState<readonly AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [verifyError, setVerifyError] = useState<unknown>(null);
  const [verifying, setVerifying] = useState(false);

  // El rango es obligatorio en el BFF (≤ 365 días): se fija al cambiar el selector.
  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - Number(days) * 86400000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const query = {
    ...range,
    outcome: outcome || undefined,
    action: action || undefined,
    actorId: actorId || undefined,
    ...parseResource(resource),
    pageSize: 100,
  };
  const page = useAsync(
    () => api.get<Page<AuditEvent>>('/audit/events', query),
    [api, range, outcome, action, actorId, resource],
  );

  useEffect(() => {
    if (page.data) {
      setItems(page.data.items);
      setCursor(page.data.nextCursor);
    }
  }, [page.data]);

  const loadMore = async () => {
    if (!cursor) return;
    const next = await api.get<Page<AuditEvent>>('/audit/events', { ...query, cursor });
    setItems((current) => [...current, ...next.items]);
    setCursor(next.nextCursor);
  };

  const verify = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      setVerification(await api.get<AuditVerification>('/audit/verify'));
    } catch (failure) {
      setVerifyError(failure);
    } finally {
      setVerifying(false);
    }
  };

  const columns: Array<EuiBasicTableColumn<AuditEvent>> = [
    {
      field: 'sequence',
      name: 'Secuencia',
      width: '96px',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      field: 'occurredAt',
      name: 'Instante',
      width: '120px',
      render: (value: string) => <Timestamp iso={value} />,
    },
    {
      field: 'action',
      name: 'Acción',
      render: (value: string) => <Mono>{value}</Mono>,
    },
    {
      field: 'actor',
      name: 'Actor',
      render: (actor: AuditEvent['actor']) => <Mono>{actor.id.slice(0, 16)}</Mono>,
    },
    {
      field: 'resource',
      name: 'Recurso',
      render: (resource: AuditEvent['resource']) => (
        <Mono>{`${resource.type}:${resource.id.slice(0, 16)}`}</Mono>
      ),
    },
    {
      field: 'outcome',
      name: 'Resultado',
      width: '120px',
      render: (value: AuditOutcome) => (
        <HealthMark tone={OUTCOME_TONE[value]} label={OUTCOME_LABEL[value]} />
      ),
    },
    {
      field: 'hash',
      name: 'Hash',
      width: '110px',
      render: (value: string) => <Mono title={value}>{value.slice(0, 10)}</Mono>,
    },
  ];

  return (
    <QapaqPage
      title="Auditoría e integridad"
      description="Rastro de todas las fuentes y acciones, encadenado con SHA-256: cualquier alteración se detecta."
      actions={
        can(CAPABILITIES.auditVerify) ? (
          <EuiButton size="s" onClick={verify} isLoading={verifying}>
            Verificar cadena
          </EuiButton>
        ) : undefined
      }
    >
      {verifyError != null && (
        <>
          <ErrorCallout error={verifyError} />
          <EuiSpacer size="m" />
        </>
      )}
      {verification && (
        <>
          <EuiCallOut
            size="s"
            color={verification.ok ? 'success' : 'danger'}
            iconType={verification.ok ? 'check' : 'alert'}
            title={
              verification.ok
                ? `Cadena íntegra: ${verification.checked} eventos verificados hasta la secuencia ${verification.headSequence}.`
                : `Cadena rota: ${verification.violations.length} anomalías en ${verification.checked} eventos.`
            }
          >
            {!verification.ok && (
              <ul className="qapaqList">
                {verification.violations.map((violation) => (
                  <li key={`${violation.code}-${violation.sequence}`}>
                    {AUDIT_VIOLATION_LABEL[violation.code] ?? violation.code} en la secuencia{' '}
                    <Mono>{violation.sequence}</Mono>
                  </li>
                ))}
              </ul>
            )}
          </EuiCallOut>
          <EuiSpacer size="m" />
        </>
      )}
      <EuiFlexGroup gutterSize="s" responsive wrap className="qapaqFilters">
        <EuiFlexItem grow={1}>
          <EuiSelect
            compressed
            fullWidth
            aria-label="Periodo"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            options={WINDOWS}
          />
        </EuiFlexItem>
        <EuiFlexItem grow={1}>
          <EuiSelect
            compressed
            fullWidth
            aria-label="Resultado"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as AuditOutcome | '')}
            options={[
              { value: '', text: 'Todos los resultados' },
              ...(Object.keys(OUTCOME_LABEL) as AuditOutcome[]).map((value) => ({
                value,
                text: OUTCOME_LABEL[value],
              })),
            ]}
          />
        </EuiFlexItem>
        <EuiFlexItem grow={2}>
          <EuiFieldSearch
            compressed
            fullWidth
            placeholder="Acción exacta, p. ej. access.session.revoked"
            value={actionInput}
            onChange={(event) => setActionInput(event.target.value)}
            onSearch={(value) => setAction(value.trim())}
            aria-label="Filtrar por acción"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={2}>
          <EuiFieldSearch
            compressed
            fullWidth
            placeholder="Actor (identificador)"
            value={actorInput}
            onChange={(event) => setActorInput(event.target.value)}
            onSearch={(value) => setActorId(value.trim())}
            aria-label="Filtrar por actor"
          />
        </EuiFlexItem>
        <EuiFlexItem grow={2}>
          <EuiFieldSearch
            compressed
            fullWidth
            placeholder="Recurso: tipo o tipo:id (p. ej. incident:…)"
            value={resourceInput}
            onChange={(event) => setResourceInput(event.target.value)}
            onSearch={(value) => setResource(value.trim())}
            aria-label="Filtrar por recurso"
          />
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiSpacer size="m" />
      {page.error ? (
        <ErrorCallout error={page.error} onRetry={page.reload} />
      ) : (
        <DataZone>
          <EuiBasicTable<AuditEvent>
            items={items as AuditEvent[]}
            columns={columns}
            loading={page.loading}
            responsive
            compressed
            tableLayout="auto"
            noItemsMessage={
              page.loading ? 'Cargando auditoría…' : 'Sin eventos en el periodo y filtros elegidos.'
            }
          />
          {cursor && (
            <>
              <EuiSpacer size="s" />
              <EuiButtonEmpty size="s" onClick={loadMore}>
                Cargar más
              </EuiButtonEmpty>
            </>
          )}
        </DataZone>
      )}
    </QapaqPage>
  );
}
