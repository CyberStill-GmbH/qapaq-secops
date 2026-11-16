/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EuiButtonEmpty, EuiLoadingContent } from '@elastic/eui';
import {
  AGENT_GROUP_POLICIES,
  MANAGER_POLICIES,
  PolicyFact,
  RETENTION_POLICIES,
} from '../../common';
import { fetchOverview } from '../api/overview';
import { formatNumber } from './overview_parts';
import { useAsync } from './primitives';

/**
 * «Políticas»: resumen de lo aplicado como código (docs/16-politicas.md). Los conteos de agentes
 * por grupo salen del último muestreo de wazuh-monitoring-* con la identidad de quien mira.
 */
export function PoliciesView({ basePath }: { basePath: string }) {
  const overview = useAsync(() => fetchOverview(basePath), [basePath]);
  const agents = overview.data?.agents ?? null;
  const counted = overview.data?.monitoringAccess === 'ok';
  return (
    <main className="qapaqPage qapaqOverview">
      <header className="qapaqHero">
        <div className="qapaqHero__text">
          <span className="qapaqHero__eyebrow">QAPAQ SOC</span>
          <h1>Políticas</h1>
          <p>
            Políticas de seguridad aplicadas como código: grupos de agentes, manager y retención. Se
            reaplican con <code>infra/wazuh/policies/apply-policies.sh</code>.
          </p>
        </div>
        <div className="qapaqHero__actions">
          <EuiButtonEmpty size="s" href={`${basePath}/app/qapaq-integrations`}>
            Ver integraciones
          </EuiButtonEmpty>
        </div>
      </header>

      <section className="qapaqPanel" aria-labelledby="qapaq-policy-manager">
        <div className="qapaqPanel__header">
          <h2 id="qapaq-policy-manager">Manager y detección</h2>
        </div>
        <FactGrid facts={MANAGER_POLICIES} />
      </section>

      <section className="qapaqPanel" aria-labelledby="qapaq-policy-groups">
        <div className="qapaqPanel__header">
          <h2 id="qapaq-policy-groups">Grupos de agentes</h2>
          <span className="qapaqPanel__meta">
            {agents?.measuredAt
              ? 'Agentes según el último muestreo'
              : 'FIM · SCA · inventario · logs'}
          </span>
        </div>
        {overview.loading && !overview.data ? (
          <EuiLoadingContent lines={4} />
        ) : (
          <div className="qapaqTableScroll">
            <table className="qapaqPolicyTable">
              <thead>
                <tr>
                  <th scope="col">Grupo</th>
                  <th scope="col">Agentes</th>
                  <th scope="col">Integridad (FIM)</th>
                  <th scope="col">SCA</th>
                  <th scope="col">Inventario y vulnerabilidades</th>
                  <th scope="col">Logs</th>
                </tr>
              </thead>
              <tbody>
                {AGENT_GROUP_POLICIES.map((group) => (
                  <tr key={group.name}>
                    <th scope="row">
                      <code>{group.name}</code>
                    </th>
                    <td className="qapaqTabular">
                      {counted ? formatNumber(agents?.groups[group.name] ?? 0) : '—'}
                    </td>
                    <td>{group.fim}</td>
                    <td>{group.sca}</td>
                    <td>{group.inventory}</td>
                    <td>{group.logs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!counted && overview.data && (
          <p className="qapaqPanel__empty">
            Tu rol no puede leer wazuh-monitoring-*: no se muestran los agentes por grupo.
          </p>
        )}
      </section>

      <section className="qapaqPanel" aria-labelledby="qapaq-policy-retention">
        <div className="qapaqPanel__header">
          <h2 id="qapaq-policy-retention">Retención del Indexer (ISM)</h2>
          <span className="qapaqPanel__meta">Sin snapshots S3 en el nodo PowerUser</span>
        </div>
        <FactGrid facts={RETENTION_POLICIES} />
      </section>
    </main>
  );
}

function FactGrid({ facts }: { facts: readonly PolicyFact[] }) {
  return (
    <dl className="qapaqFactGrid">
      {facts.map((fact) => (
        <div key={fact.title} className="qapaqFactGrid__item">
          <dt>{fact.title}</dt>
          <dd>
            <strong>{fact.value}</strong>
            <span>{fact.detail}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
