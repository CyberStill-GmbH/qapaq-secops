import type { DetectionRuleSummary } from '../../api/admin.js';
import { Status, TableFrame, formatDate } from './admin-ui.js';

export function DetectionViews({ rules }: { rules: readonly DetectionRuleSummary[] }) {
  return <div className="view-stack"><div className="data-section table-section"><TableFrame>
    <thead><tr><th>Regla</th><th>Estado</th><th>Versión</th><th>Disparos · 24 h</th><th>Falsos positivos</th><th>Actualizada</th></tr></thead>
    <tbody>{rules.map((rule) => <tr key={rule.id}><td><strong>{rule.name}</strong><small><code>{rule.id}</code></small></td><td><Status value={rule.status} /></td><td>{rule.version}</td><td>{rule.hitsLast24h}</td><td>{(rule.falsePositiveRate * 100).toFixed(1)}%</td><td>{formatDate(rule.updatedAt)}</td></tr>)}</tbody>
  </TableFrame></div><p className="data-footnote">Rendimiento sintético. La publicación de reglas requiere revisión y separación de funciones; esta demo no modifica reglas.</p></div>;
}
