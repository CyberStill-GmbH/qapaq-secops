/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AI_CLOSE_BENIGN_GUARDS,
  AiRunDetail,
  AnalystSettings,
  draftFromSettings,
  normalizeBudget,
  normalizeDigest,
  normalizeRunDetail,
} from '../../common';
import { AiBudgetPanel, AiModeLine } from './ai_analyst_budget';
import {
  AiCaseFile,
  AiCaseFileActions,
  AiRunActions,
  AiRunStatusCallout,
  runQuestion,
} from './ai_analyst_case_file';
import { AiDigestView } from './ai_analyst_reports';
import { AiRunList, runCostText } from './ai_analyst_runs';
import { AiSettingsConfirmBody, AiSettingsForm, serverFieldErrors } from './ai_analyst_settings';

const NOW = Date.parse('2026-11-13T10:01:00.000Z');

function run(overrides: Record<string, unknown> = {}): AiRunDetail {
  const detail = normalizeRunDetail({
    id: 'run-1',
    status: 'completed',
    stage: null,
    priority: 'P3',
    trigger: 'system',
    initiatedBy: null,
    subject: { kind: 'alert', id: 'a-1', title: 'Acceso desde país nuevo' },
    alertCount: 1,
    inference: 'none',
    verdict: 'likely_false_positive',
    confidence: 'high',
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:05.000Z',
    finishedAt: '2026-11-13T10:00:05.000Z',
    revision: 2,
    estimatedCostMicroUsd: null,
    actionKinds: [],
    policyVersion: 'p-1',
    attempt: 1,
    lastErrorCode: null,
    cancelRequested: false,
    alertIds: ['a-1'],
    events: [],
    evidence: null,
    result: {
      summary: 'Patrón conocido.',
      verdict: 'likely_false_positive',
      confidence: 'high',
      recommendedPriority: 'P4',
      facts: [{ text: 'Hecho observado', citations: ['a-1'] }],
      inferences: [],
      gaps: [],
      nextSteps: [],
      citations: [{ kind: 'alert', id: 'a-1', label: 'Alerta a-1' }],
      verified: true,
      deterministic: { reasons: ['KNOWN_BENIGN_PATTERN', 'BRAND_NEW_CODE'] },
    },
    usage: null,
    invocations: [],
    actions: [],
    ...overrides,
  });
  if (!detail) throw new Error('fixture');
  return detail;
}

const SETTINGS: AnalystSettings = {
  revision: 4,
  updatedAt: '2026-11-13T09:00:00.000Z',
  updatedBy: 'li***@qapaq.pe',
  enabled: true,
  mode: 'shadow',
  scope: { priorities: ['P1', 'P2', 'P3'], inferenceMinPriority: 'P2' },
  actions: {
    escalate: true,
    requestReview: true,
    acknowledge: false,
    closeBenign: false,
    attachReport: false,
  },
  escalation: { minConfidence: 'high', priorities: ['P1'] },
  closeBenign: { maxPriority: 'P4', minHistory: 5 },
  review: { notifyPriorities: ['P1'], notifyOnStatuses: ['failed'] },
  budget: { dailyCeilingMicroUsd: null, maxOutputTokens: 2000, advancedTierEnabled: false },
  reports: { perRun: true, digest: 'off', digestHourLima: 8 },
  instructions: 'Prioriza cuentas privilegiadas.',
};

function settingsForm(overrides: Partial<React.ComponentProps<typeof AiSettingsForm>> = {}) {
  return renderToStaticMarkup(
    <AiSettingsForm
      saved={SETTINGS}
      draft={draftFromSettings(SETTINGS)}
      errors={{}}
      canEdit
      dirty={false}
      busy={false}
      onChange={() => undefined}
      onSave={() => undefined}
      onDiscard={() => undefined}
      {...overrides}
    />,
  );
}

describe('avisos por estado del expediente', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['requires_review', {}, 'Requiere revisión humana'],
    ['budget_exhausted', {}, 'Presupuesto diario agotado'],
    ['usage_unreconciled', {}, 'Uso por conciliar'],
    ['partial', {}, 'Resultado parcial'],
    ['cancelled', {}, 'Investigación detenida'],
    ['failed', { lastErrorCode: 'MODEL_TIMEOUT' }, 'La investigación falló'],
  ];
  for (const [status, extra, title] of cases) {
    it(`muestra un aviso propio para ${status}`, () => {
      const markup = renderToStaticMarkup(<AiRunStatusCallout run={run({ status, ...extra })} />);
      expect(markup).toContain(title);
    });
  }

  it('el error se muestra solo si es un código seguro', () => {
    expect(
      renderToStaticMarkup(
        <AiRunStatusCallout run={run({ status: 'failed', lastErrorCode: 'MODEL_TIMEOUT' })} />,
      ),
    ).toContain('MODEL_TIMEOUT');
    const unsafe = renderToStaticMarkup(
      <AiRunStatusCallout run={run({ status: 'failed', lastErrorCode: '<b>stack trace</b>' })} />,
    );
    expect(unsafe).not.toContain('stack trace');
    expect(unsafe).toContain('no informó un código');
  });

  it('una corrida completa o en curso no lleva aviso de estado', () => {
    expect(renderToStaticMarkup(<AiRunStatusCallout run={run()} />)).toBe('');
    expect(
      renderToStaticMarkup(<AiRunStatusCallout run={run({ status: 'running', finishedAt: null })} />),
    ).toBe('');
  });
});

describe('expediente', () => {
  it('una corrida determinista dice «Sin IA» y no muestra costo', () => {
    const markup = renderToStaticMarkup(<AiCaseFile run={run()} basePath="" now={NOW} />);
    expect(markup).toContain('Sin IA');
    expect(markup).toContain('sin llamada al modelo');
    expect(markup).not.toContain('US$');
    expect(runCostText(run())).toBe('Sin llamada al modelo');
    expect(runCostText(run({ inference: 'economy' }))).toBe('Sin dato');
  });

  it('separa hechos, inferencias, vacíos y pasos; motivos deterministas con código crudo si es nuevo', () => {
    const markup = renderToStaticMarkup(<AiCaseFile run={run()} basePath="/b" now={NOW} />);
    for (const title of ['Hechos observados', 'Inferencias', 'Vacíos de evidencia', 'Siguientes pasos']) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain('Coincide con un patrón benigno conocido');
    expect(markup).toContain('BRAND_NEW_CODE');
    expect(markup).toContain('href="/b/app/qapaq-alerts?id=a-1"');
    expect(markup).toContain('no cambió la alerta');
    expect(markup).not.toContain('Sin citas verificadas');
  });

  it('un resultado sin verificar lleva el aviso de revisión humana', () => {
    const base = run();
    const markup = renderToStaticMarkup(
      <AiCaseFile
        run={{ ...base, result: { ...base.result!, verified: false } }}
        basePath=""
        now={NOW}
      />,
    );
    expect(markup).toContain('Sin citas verificadas: requiere revisión humana');
  });

  it('escapa el texto del modelo y lo marca como zona de datos', () => {
    const base = run();
    const markup = renderToStaticMarkup(
      <AiCaseFile
        run={{
          ...base,
          result: {
            ...base.result!,
            summary: '<img src=x onerror=alert(1)>',
            facts: [{ text: '<script>robar()</script>', citations: [] }],
          },
        }}
        basePath=""
        now={NOW}
      />,
    );
    expect(markup).not.toContain('<img src=x');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).toContain('data-qapaq-no-translate');
  });

  it('el progreso es un registro en vivo sin porcentaje inventado', () => {
    const markup = renderToStaticMarkup(
      <AiCaseFile
        run={run({
          status: 'running',
          stage: 'model',
          finishedAt: null,
          events: [
            { sequence: 1, at: '2026-11-13T10:00:00.000Z', stage: 'triage', kind: 'started' },
            { sequence: 2, at: '2026-11-13T10:00:02.000Z', stage: 'triage', kind: 'completed' },
          ],
        })}
        basePath=""
        now={NOW}
      />,
    );
    expect(markup).toContain('role="log"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Triaje determinista');
    expect(markup).toContain('1 min 00 s');
    expect(markup).not.toContain('%');
    expect(markup).not.toContain('Validación de citas');
  });

  it('la cobertura parcial no se presenta como completa', () => {
    const markup = renderToStaticMarkup(
      <AiCaseFile
        run={run({
          evidence: {
            complete: false,
            truncated: true,
            alertsScanned: 3,
            eventsScanned: null,
            sources: [{ id: 's', label: 'Microsoft 365', state: 'degraded', fresh: false }],
            gaps: ['Sin datos de VPN'],
          },
        })}
        basePath=""
        now={NOW}
      />,
    );
    expect(markup).toContain('Evidencia parcial');
    expect(markup).toContain('Truncada');
    expect(markup).toContain('Degradada');
    expect(markup).toContain('datos desactualizados');
    expect(markup).not.toContain('Evidencia completa');
  });

  it('las invocaciones muestran uso por conciliar y costo estimado', () => {
    const markup = renderToStaticMarkup(
      <AiCaseFile
        run={run({
          inference: 'economy',
          estimatedCostMicroUsd: 12300,
          usage: { inputTokens: 12000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: null },
          invocations: [
            { phase: 'analysis', tier: 'economy', model: 'modelo-x', state: 'usage_unknown', estimatedMicroUsd: null },
          ],
        })}
        basePath=""
        now={NOW}
      />,
    );
    expect(markup).toContain('Uso por conciliar');
    expect(markup).toContain('US$ 0,0123 (estimado)');
    expect(markup).toContain('facturación no conectada');
    expect(markup).toContain((12000).toLocaleString('es-PE'));
  });
});

describe('acciones del expediente', () => {
  const noop = () => undefined;

  it('sin investigations.run no se ofrecen Detener ni Reintentar', () => {
    const active = renderToStaticMarkup(
      <AiCaseFileActions
        run={run({ status: 'running', finishedAt: null })}
        basePath=""
        canRun={false}
        busy={false}
        onCancel={noop}
        onRetry={noop}
        onAskQapaqzito={noop}
      />,
    );
    expect(active).not.toContain('Detener');
    expect(active).toContain('Abrir alerta');
    expect(active).toContain('Preguntar a Qapaqzito');
    const failed = renderToStaticMarkup(
      <AiCaseFileActions
        run={run({ status: 'failed' })}
        basePath=""
        canRun={false}
        busy={false}
        onCancel={noop}
        onRetry={noop}
        onAskQapaqzito={noop}
      />,
    );
    expect(failed).not.toContain('Reintentar');
  });

  it('con investigations.run: Detener en curso, Reintentar al fallar, informe al terminar', () => {
    const active = renderToStaticMarkup(
      <AiCaseFileActions
        run={run({ status: 'running', finishedAt: null })}
        basePath=""
        canRun
        busy={false}
        onCancel={noop}
        onRetry={noop}
        onAskQapaqzito={noop}
        onDownloadReport={noop}
      />,
    );
    expect(active).toContain('Detener');
    expect(active).not.toContain('Descargar informe');
    const failed = renderToStaticMarkup(
      <AiCaseFileActions
        run={run({ status: 'failed' })}
        basePath=""
        canRun
        busy={false}
        onCancel={noop}
        onRetry={noop}
        onAskQapaqzito={noop}
        onDownloadReport={noop}
      />,
    );
    expect(failed).toContain('Reintentar');
    expect(failed).toContain('Guardar informe como PDF');
  });

  it('el borrador para Qapaqzito pide contrastar, no ejecutar', () => {
    const text = runQuestion(run());
    expect(text).toContain('run-1');
    expect(text).toContain('No cambies la alerta');
  });
});

describe('acciones del analista', () => {
  it('distingue ejecutada, omitida y fallida, con motivo y enlace', () => {
    const markup = renderToStaticMarkup(
      <AiRunActions
        basePath="/b"
        mode="autonomous"
        actions={
          run({
            actions: [
              {
                id: '1',
                kind: 'escalate',
                state: 'executed',
                reason: 'VERDICT_TRUE_POSITIVE',
                at: '2026-11-13T10:00:04.000Z',
                executedAt: '2026-11-13T10:00:04.000Z',
                ref: { kind: 'incident', id: 'inc-9' },
                errorCode: null,
              },
              { id: '2', kind: 'close_benign', state: 'skipped', reason: 'GUARD_NOT_MET', at: null, ref: null },
              { id: '3', kind: 'request_review', state: 'failed', reason: 'NEW_REASON', errorCode: 'TEAMS_DOWN', ref: null },
              { id: '4', kind: '<b>x</b>', state: 'planned', reason: null, ref: null },
            ],
          }).actions
        }
      />,
    );
    expect(markup).toContain('El analista ejecutó 1 acción');
    expect(markup).toContain('Ejecutada');
    expect(markup).toContain('Omitida');
    expect(markup).toContain('Falló, no se aplicó');
    expect(markup).toContain('Propuesta, no ejecutada');
    expect(markup).toContain('El veredicto apunta a un verdadero positivo');
    expect(markup).toContain('NEW_REASON');
    expect(markup).toContain('TEAMS_DOWN');
    expect(markup).toContain('href="/b/app/qapaq-incidents?id=inc-9"');
    expect(markup).toContain('data-state="skipped"');
    expect(markup).not.toContain('<b>x</b>');
    expect(markup).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('en sombra y asistido deja claro que nada cambió', () => {
    const shadow = renderToStaticMarkup(<AiRunActions basePath="" mode="shadow" actions={[]} />);
    expect(shadow).toContain('no cambió alertas ni envió avisos');
    expect(shadow).toContain('modo sombra');
    const assisted = renderToStaticMarkup(<AiRunActions basePath="" mode="assisted" actions={[]} />);
    expect(assisted).toContain('modo asistido');
  });
});

describe('franja de modo y presupuesto', () => {
  it('refleja el modo real y no supone sombra si no llegó', () => {
    expect(renderToStaticMarkup(<AiModeLine mode="shadow" />)).toContain('Modo sombra');
    expect(renderToStaticMarkup(<AiModeLine mode="assisted" />)).toContain('pide revisión humana');
    expect(renderToStaticMarkup(<AiModeLine mode="autonomous" />)).toContain('Modo autónomo');
    const unknown = renderToStaticMarkup(<AiModeLine mode={null} />);
    expect(unknown).not.toContain('Modo sombra');
    expect(unknown).toContain('sin dato');
  });

  it('sin techo diario dice que la IA está apagada y no muestra ceros inventados', () => {
    const markup = renderToStaticMarkup(
      <AiBudgetPanel
        budget={normalizeBudget({
          mode: 'shadow',
          inferenceEnabled: true,
          day: { limitMicroUsd: null, unknownInvocations: 0 },
          runs: { today: 4, withoutInference: 4 },
        })}
      />,
    );
    expect(markup).toContain('Sin techo configurado');
    expect(markup).toContain('la inferencia está apagada');
    expect(markup).toContain('solo con reglas deterministas');
    expect(markup).toContain('100 % del día');
    expect(markup).toContain('Sin dato');
    expect(markup).toContain('Costo estimado; facturación no conectada');
    expect(markup).not.toContain('Uso por conciliar');
  });

  it('avisa del uso por conciliar', () => {
    const markup = renderToStaticMarkup(
      <AiBudgetPanel
        budget={normalizeBudget({
          mode: 'autonomous',
          inferenceEnabled: true,
          day: { limitMicroUsd: 5000000, unknownInvocations: 2 },
        })}
      />,
    );
    expect(markup).toContain('Uso por conciliar: 2 llamadas');
    expect(markup).not.toContain('la inferencia está apagada');
  });
});

describe('lista de investigaciones', () => {
  it('fila escaneable: prioridad, título escapado, conclusión, estado y acciones ejecutadas', () => {
    const base = run();
    const markup = renderToStaticMarkup(
      <AiRunList
        items={[
          { ...base, subject: { ...base.subject, title: '<i>t</i>' }, actionKinds: ['escalate', 'odd'] },
        ]}
        loading={false}
        basePath="/b"
        onSelect={() => undefined}
        empty="vacío"
      />,
    );
    expect(markup).toContain('Sin IA');
    expect(markup).toContain('Escaló');
    expect(markup).toContain('odd');
    expect(markup).not.toContain('<i>t</i>');
    expect(markup).toContain('&lt;i&gt;t&lt;/i&gt;');
    expect(markup).toContain('href="/b/app/qapaq-ai-analyst?id=run-1"');
    expect(markup).toContain('Probable falso positivo');
    expect(markup).toContain('Confianza alta');
    expect(markup).toContain('Completada');
    expect(markup).toContain('data-priority="p3"');
  });

  it('con modelo muestra el nivel y el costo; sin cifra, «Sin dato»', () => {
    const markup = renderToStaticMarkup(
      <AiRunList
        items={[run({ inference: 'economy' })]}
        loading={false}
        basePath=""
        onSelect={() => undefined}
        empty="vacío"
      />,
    );
    expect(markup).toContain('IA: económico · Sin dato');
  });

  it('vacía muestra el mensaje que explica qué hacer', () => {
    const markup = renderToStaticMarkup(
      <AiRunList items={[]} loading={false} basePath="" onSelect={() => undefined} empty="Quita los filtros" />,
    );
    expect(markup).toContain('Quita los filtros');
    expect(markup).toContain('role="status"');
  });
});

describe('formulario de configuración', () => {
  it('sin permiso queda en solo lectura con todos los controles deshabilitados', () => {
    const markup = settingsForm({ canEdit: false });
    expect(markup).toContain('Solo lectura');
    expect(markup).toContain('investigations.configure');
    expect(markup).not.toContain('Guardar configuración');
    expect(markup).not.toMatch(/<input(?![^>]*disabled)[^>]*>/u);
  });

  it('muestra las condiciones del cierre benigno que no se pueden desactivar', () => {
    const markup = settingsForm();
    for (const guard of AI_CLOSE_BENIGN_GUARDS) expect(markup).toContain(guard);
    expect(markup).toContain('No puede conceder permisos');
  });

  it('en modo sombra deshabilita las acciones en vez de ocultarlas', () => {
    const markup = settingsForm();
    expect(markup).toContain('Escalar a incidente');
    expect(markup).toContain('estos permisos se conservan, pero no tienen efecto');
    // «Escalar» sigue marcado (conserva su valor) pero deshabilitado.
    const escalate = /<label><input([^>]*)\/>Escalar a incidente<\/label>/u.exec(markup);
    expect(escalate).not.toBeNull();
    expect(escalate![1]).toContain('disabled=""');
    expect(escalate![1]).toContain('checked=""');
  });

  it('muestra los errores de validación y el contador de caracteres', () => {
    const markup = settingsForm({
      dirty: true,
      errors: { 'closeBenign.minHistory': 'Escribe un número entero entre 3 y 50.' },
    });
    expect(markup).toContain('Escribe un número entero entre 3 y 50.');
    expect(markup).toContain('Hay campos por corregir.');
    expect(markup).toContain(`${1000 - SETTINGS.instructions.length} caracteres disponibles`);
  });

  it('la confirmación del modo autónomo explica las consecuencias', () => {
    const markup = renderToStaticMarkup(
      <AiSettingsConfirmBody risk={{ autonomous: true, closeBenign: true }} />,
    );
    expect(markup).toContain('Vas a activar el modo autónomo');
    expect(markup).toContain('sin esperar a una persona');
    expect(markup).toContain('Vas a permitir el cierre de alertas benignas conocidas');
    expect(markup).toContain(AI_CLOSE_BENIGN_GUARDS[1]);
  });

  it('las rutas de VALIDATION_FAILED se aceptan solo si son rutas de campo', () => {
    expect(serverFieldErrors(['settings.budget.maxOutputTokens', '<x>'])).toEqual({
      'budget.maxOutputTokens': 'El servicio rechazó este valor.',
    });
  });
});

describe('resumen del periodo', () => {
  it('muestra totales, conteos ausentes como «Sin dato» y el costo estimado', () => {
    const markup = renderToStaticMarkup(
      <AiDigestView
        digest={
          normalizeDigest({
            from: '2026-11-07',
            to: '2026-11-13',
            totals: { runs: 12, escalated: 0 },
            byPriority: { P1: 2 },
            topRules: [{ ruleId: '101503', count: 4 }],
            estimatedMicroUsd: 45000,
            markdown: '# Resumen',
          })!
        }
        onDownload={() => undefined}
      />,
    );
    expect(markup).toContain('Escaladas');
    expect(markup).toContain('Sin dato');
    expect(markup).toContain('101503');
    expect(markup).toContain('US$ 0,0450 (estimado)');
    expect(markup).toContain('Guardar resumen como PDF');
  });

  it('sin texto no ofrece una descarga vacía', () => {
    const markup = renderToStaticMarkup(
      <AiDigestView digest={normalizeDigest({ totals: {} })!} onDownload={() => undefined} />,
    );
    expect(markup).not.toContain('Descargar resumen');
    expect(markup).toContain('no entregó el texto');
  });
});

import { DeploymentOffCallout } from './ai_analyst_settings';

describe('DeploymentOffCallout', () => {
  it('explica que lo guardado no se aplica mientras el despliegue tenga el analista apagado', () => {
    const html = renderToStaticMarkup(<DeploymentOffCallout />);
    expect(html).toContain('apagado en este despliegue');
    expect(html).toContain('QAPAQ_ANALYST_ENABLED=true');
  });
});
