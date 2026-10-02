import { useCallback, useEffect, useState } from 'react';
import type { ApiErrorBody } from '@qapaq/contracts';
import { api, type AuditIntegrityView, type SessionView } from '../../api/client.js';
import { Button, ErrorState, SocIcon, StatusChip } from './soc-ui.js';
import { PageHeader, Panel } from './soc-data-ui.js';

export function IntegrityPage({ session }: { readonly session: SessionView }): React.JSX.Element {
  const [result, setResult] = useState<AuditIntegrityView | null>(null);
  const [error, setError] = useState<ApiErrorBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const verify = useCallback(async () => {
    setBusy(true);
    const response = await api.verifyAudit();
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response.data);
    setError(null);
    setCheckedAt(new Date().toISOString());
  }, []);
  useEffect(() => {
    if (session.capabilities.includes('audit.verify')) void verify();
  }, [session.capabilities, verify]);
  return (
    <div className="soc-page">
      <PageHeader
        title="Integridad de auditoría"
        description="Verifica la continuidad de la cadena de eventos."
        updated={checkedAt}
        action={
          <Button variant="primary" onClick={() => void verify()} disabled={busy}>
            <SocIcon name="shield" />
            {busy ? 'Verificando…' : 'Verificar cadena'}
          </Button>
        }
      />
      {error ? <ErrorState error={error} onRetry={() => void verify()} /> : null}
      {result ? (
        <Panel title="Resultado de verificación">
          <div className="soc-integrity-summary soc-integrity-summary--large">
            <StatusChip state={result.ok ? 'ok' : 'fail'}>
              {result.ok ? 'Cadena íntegra' : 'Cadena con violaciones'}
            </StatusChip>
            <p>
              {result.checked.toLocaleString('es-PE')} eventos revisados · secuencia{' '}
              {result.headSequence}
            </p>
            <small>La verificación revisa los primeros 1 000 eventos.</small>
          </div>
          {result.violations.length ? (
            <div className="soc-table-scroll">
              <table className="soc-table">
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Secuencia</th>
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {result.violations.map((violation) => (
                    <tr key={`${violation.code}-${violation.sequence}`}>
                      <td>
                        <code>{violation.code}</code>
                      </td>
                      <td>
                        <code>{violation.sequence}</code>
                      </td>
                      <td>{violation.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
