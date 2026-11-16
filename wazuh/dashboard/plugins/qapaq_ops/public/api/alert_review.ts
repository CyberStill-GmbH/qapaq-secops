/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { Alert, AlertCommandName, AlertVerdict, IncidentSeverity, isValidAlertId } from '../../common';
import { QapaqApiClient } from './client';

/**
 * Acciones de revisión del Analista IA sobre la alerta, por los endpoints de alertas EXISTENTES
 * (los mismos que usa `alerts_view.tsx`): `POST /alerts/:id/commands` y `POST /incidents`. El
 * backend aplica capacidades, compare-and-set (`expectedRevision`), auditoría y outbox; aquí solo
 * se encadenan los pasos con la revisión que devuelve cada uno.
 */

function alertPath(alertId: string, suffix = ''): string {
  if (!isValidAlertId(alertId)) throw new Error('Identificador de alerta no válido');
  return `/alerts/${encodeURIComponent(alertId)}${suffix}`;
}

export async function getAlert(api: QapaqApiClient, alertId: string): Promise<Alert> {
  const body = await api.get<{ alert: Alert }>(alertPath(alertId));
  return body.alert;
}

export async function runAlertCommand(
  api: QapaqApiClient,
  alert: Pick<Alert, 'id' | 'revision'>,
  name: AlertCommandName,
  extra: { readonly verdict?: AlertVerdict; readonly note?: string; readonly assigneeId?: string } = {},
): Promise<Alert> {
  const body = await api.post<{ alert: Alert }>(alertPath(alert.id, '/commands'), {
    name,
    expectedRevision: alert.revision,
    ...extra,
  });
  return body.alert;
}

export interface OpenIncidentInput {
  readonly title: string;
  readonly severity: IncidentSeverity;
  readonly summary: string;
}

/** `POST /incidents` desde una alerta; devuelve el id del incidente abierto. */
export async function openIncidentForAlert(
  api: QapaqApiClient,
  alert: Pick<Alert, 'id' | 'revision'>,
  input: OpenIncidentInput,
): Promise<string> {
  const body = await api.post<{ incident: { id: string } }>('/incidents', {
    alertId: alert.id,
    title: input.title.trim(),
    severity: input.severity,
    summary: input.summary.trim(),
    expectedAlertRevision: alert.revision,
  });
  return body.incident.id;
}

/**
 * Ejecuta los pasos de un plan (ver `falsePositivePlan`) en orden, cada uno con la revisión que
 * dejó el anterior. Si un paso falla, el error sube con la alerta tal como quedó (`partial`): lo
 * ya aplicado es real y la vista lo muestra al recargar.
 */
export class AlertStepError extends Error {
  public constructor(
    public readonly failure: unknown,
    public readonly partial: Alert,
    public readonly completed: number,
  ) {
    super('Paso de revisión fallido');
  }
}

export async function runAlertSteps(
  api: QapaqApiClient,
  alert: Alert,
  steps: ReadonlyArray<{ readonly name: AlertCommandName }>,
  input: { readonly subjectId: string; readonly verdict: AlertVerdict; readonly note: string },
): Promise<Alert> {
  let current = alert;
  let completed = 0;
  for (const step of steps) {
    const extra =
      step.name === 'assign'
        ? { assigneeId: input.subjectId }
        : step.name === 'triage'
          ? { verdict: input.verdict, note: input.note.trim() }
          : step.name === 'close'
            ? { note: input.note.trim() }
            : {};
    try {
      current = await runAlertCommand(api, current, step.name, extra);
    } catch (failure) {
      if (completed === 0) throw failure;
      throw new AlertStepError(failure, current, completed);
    }
    completed += 1;
  }
  return current;
}
