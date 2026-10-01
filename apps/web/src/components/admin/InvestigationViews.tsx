import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CaseSummary, SecurityEventSummary } from '../../api/admin.js';
import { Empty, SearchBox, Severity, Status, TableFrame, formatDate } from './admin-ui.js';

export function EventSearchView({
  events,
  onSearch,
}: {
  events: readonly SecurityEventSummary[];
  onSearch: (query: { q: string; from: string; to: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('2026-09-30T14:32');
  const [to, setTo] = useState('2026-10-01T14:32');
  const [rangeError, setRangeError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    const days = (end - start) / 86_400_000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || days < 0 || days > 90) {
      setRangeError('El rango debe ser válido y no puede superar 90 días.');
      return;
    }
    setRangeError('');
    onSearch({ q: query, from: new Date(start).toISOString(), to: new Date(end).toISOString() });
  }
  return (
    <div className="view-stack">
      <form className="event-query-form" onSubmit={submit}>
        <SearchBox value={query} onChange={setQuery} label="Buscar evento, regla, host o principal" />
        <label>Desde<input type="datetime-local" required value={from} onChange={(event) => setFrom(event.currentTarget.value)} /></label>
        <label>Hasta<input type="datetime-local" required value={to} onChange={(event) => setTo(event.currentTarget.value)} /></label>
        <button type="submit" className="secondary-button">Buscar</button>
        {rangeError && <span className="field-error" role="alert">{rangeError}</span>}
      </form>
      <div className="data-section table-section">
        <TableFrame>
          <thead><tr><th>Instante</th><th>Severidad</th><th>Categoría</th><th>Origen</th><th>Regla</th><th>Principal</th><th>Host</th></tr></thead>
          <tbody>{events.map((item) => <tr key={item.id}>
            <td><strong>{item.id}</strong><small>{formatDate(item.occurredAt)}</small></td>
            <td><Severity value={item.severity} /></td><td>{item.category}</td><td>{item.source}</td>
            <td><code>{item.ruleId}</code></td><td>{item.principal}</td><td>{item.host}</td>
          </tr>)}</tbody>
        </TableFrame>
        {events.length === 0 && <Empty title="Consulta sin resultados" detail="La búsqueda se completó. Amplía el rango o cambia los términos." />}
      </div>
      <p className="data-footnote">Eventos sintéticos normalizados. Esta vista no consulta ni revela payload raw.</p>
    </div>
  );
}

export function CasesView({ items }: { items: readonly CaseSummary[] }) {
  return <div className="view-stack"><div className="data-section table-section"><TableFrame>
    <thead><tr><th>Caso</th><th>Severidad</th><th>Estado</th><th>Responsable</th><th>Actualizado</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.id}><td><strong>{item.id}</strong><small>{item.title}</small></td><td><Severity value={item.severity} /></td><td><Status value={item.state} /></td><td>{item.owner}</td><td>{formatDate(item.updatedAt)}</td></tr>)}</tbody>
  </TableFrame>{items.length === 0 && <Empty title="Sin casos asignados" detail="La consulta respondió correctamente sin casos en tu scope." />}</div>
  <p className="data-footnote">Casos de demostración en solo lectura. La relación entre alertas y casos queda sujeta al contrato del backend.</p></div>;
}
