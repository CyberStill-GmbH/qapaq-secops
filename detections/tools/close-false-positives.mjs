// QAPAQ SOC · cierre auditado de alertas falsas positivas por regla (docs/17 §Ajuste y reducción de falsos positivos).
//
// Corre UNA vez dentro de la imagen de la API (mismo código de dominio, misma auditoría con cadena hash) como
// principal de servicio, nunca con el login de una persona. Cada alerta pasa por los comandos normales del
// dominio: assign → triage(false_positive, nota) → close(nota). Sin --apply solo lista lo que haría.
//
//   docker run --rm --network qapaq_default --env-file <env de qapaq-api-1> \
//     -v "$PWD/detections/tools/close-false-positives.mjs:/app/dist/qapaq-close-fp.mjs:ro" \
//     qapaq/api:local dist/qapaq-close-fp.mjs --rule 521 --search rootkit \
//     --reason "falso positivo: rootcheck sobre overlay de Docker (regla 521)" [--apply]
import { executeAlertCommand } from '@qapaq/soc';
import { buildApi } from './bootstrap.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const rule = opt('rule');
const reason = opt('reason');
const search = opt('search', '');
const apply = args.includes('--apply');
const limit = Number(opt('limit', '100000'));
if (!rule || !reason || reason.length < 10) {
  console.error('uso: --rule <id> --reason "<motivo de al menos 10 caracteres>" [--search texto] [--apply] [--limit n]');
  process.exit(2);
}

const api = await buildApi(process.env, () => {});
const runtime = api.runtime;
const tenantId = runtime.tenantId;
const stamp = new Date().toISOString().replace(/[-:.]/gu, '');
const actor = {
  subjectId: 'svc:qapaq-detection-engineering',
  tenantId,
  sessionId: `oneoff:close-fp:${rule}:${stamp}`,
  capabilities: new Set(['alerts.assign', 'alerts.triage']),
  roles: ['qapaq.service.detection-engineering'],
};
const correlationId = `close-fp-${rule}-${stamp}`;

const { items, total } = await runtime.soc.listAlerts({ tenantId, status: 'open', ...(search ? { search } : {}) });
const targets = items.filter((alert) => alert.ruleId === rule).slice(0, limit);
console.log(JSON.stringify({ event: 'close-fp.plan', rule, open: total, matching: targets.length, apply, correlationId }));

let closed = 0;
const failures = {};
for (const original of targets) {
  let alert = original;
  const run = async (command) => {
    const result = await executeAlertCommand(runtime.socDependencies(), {
      actor,
      alertId: alert.id,
      correlationId,
      command: { ...command, expectedRevision: alert.revision },
    });
    if (!result.ok) throw new Error(`${command.name}:${result.code}`);
    alert = result.value;
  };
  if (!apply) continue;
  try {
    if (alert.status === 'new' || alert.assigneeId !== actor.subjectId) {
      await run({ name: 'assign', assigneeId: actor.subjectId });
    }
    if (alert.status === 'acknowledged') await run({ name: 'triage', verdict: 'false_positive', note: reason });
    await run({ name: 'close', note: reason });
    closed += 1;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN';
    failures[code] = (failures[code] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ event: 'close-fp.done', rule, closed, failures }));
await api.stop();
process.exit(Object.keys(failures).length > 0 ? 1 : 0);
