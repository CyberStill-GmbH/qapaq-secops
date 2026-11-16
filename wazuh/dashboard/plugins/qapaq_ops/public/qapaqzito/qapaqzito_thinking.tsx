/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Icon } from './qapaqzito_icons';
import type { QapaqzitoProgressEvent } from './chat_client';

export type QapaqzitoProgressStatus = 'running' | 'complete' | 'no-result';

export interface QapaqzitoProgressStep {
  readonly key: string;
  readonly label: string;
  readonly status: QapaqzitoProgressStatus;
}

function findLastIndex<T>(items: readonly T[], matches: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (matches(items[index]!)) return index;
  }
  return -1;
}

/** Projects the SSE stream into a timeline; it does not synthesize omitted server actions. */
export function qapaqzitoProgressTimeline(events: readonly QapaqzitoProgressEvent[]): QapaqzitoProgressStep[] {
  const steps: QapaqzitoProgressStep[] = [];
  const setStatus = (index: number, status: QapaqzitoProgressStatus) => {
    const step = steps[index];
    if (step) steps[index] = { ...step, status };
  };

  events.forEach((event, index) => {
    if (event.type === 'transport_fallback') return;
    if (event.type === 'model_started') {
      const activeModel = findLastIndex(
        steps,
        (step) => step.key.startsWith('model:') && step.status === 'running',
      );
      if (activeModel >= 0) setStatus(activeModel, 'complete');
      steps.push({
        key: `model:${event.round}:${index}`,
        label: `Consulta al modelo · ronda ${event.round}`,
        status: 'running',
      });
      return;
    }
    if (event.type === 'tool_started') {
      const activeModel = findLastIndex(
        steps,
        (step) => step.key.startsWith('model:') && step.status === 'running',
      );
      if (activeModel >= 0) setStatus(activeModel, 'complete');
      steps.push({ key: `tool:${event.label}:${index}`, label: event.label, status: 'running' });
      return;
    }
    const activeTool = findLastIndex(
      steps,
      (step) => step.key.startsWith(`tool:${event.label}:`) && step.status === 'running',
    );
    if (activeTool >= 0) setStatus(activeTool, event.ok ? 'complete' : 'no-result');
    else
      steps.push({
        key: `tool:${event.label}:${index}`,
        label: event.label,
        status: event.ok ? 'complete' : 'no-result',
      });
  });
  return steps;
}

export function elapsedLabel(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return minutes > 0 ? `${minutes} min ${String(remainder).padStart(2, '0')} s` : `${remainder} s`;
}

const STATUS_LABEL: Record<QapaqzitoProgressStatus, string> = {
  running: 'En curso',
  complete: 'Completo',
  'no-result': 'Sin resultado',
};

function toolsLabel(count: number): string {
  return `${count} ${count === 1 ? 'herramienta' : 'herramientas'}`;
}

/** Cuántas consultas a herramientas hizo Qapaqzito (las rondas del modelo no cuentan). */
export function toolCount(steps: readonly QapaqzitoProgressStep[]): number {
  return steps.filter((step) => step.key.startsWith('tool:')).length;
}

/** Línea de resumen: «Trabajando… · 3 herramientas · 12 s» en curso; «Trabajó 12 s · 3 herramientas» al terminar. */
export function activitySummary(options: {
  readonly tools: number;
  readonly seconds?: number | null;
  readonly live: boolean;
}): string {
  const parts: string[] = [];
  const duration =
    options.seconds === null || options.seconds === undefined
      ? null
      : elapsedLabel(options.seconds);
  if (options.live) {
    parts.push('Trabajando…');
    if (options.tools > 0) parts.push(toolsLabel(options.tools));
    if (duration) parts.push(duration);
    return parts.join(' · ');
  }
  parts.push(duration ? `Trabajó ${duration}` : 'Actividad');
  if (options.tools > 0) parts.push(toolsLabel(options.tools));
  return parts.join(' · ');
}

function StepList({ steps, label }: { steps: readonly QapaqzitoProgressStep[]; label: string }) {
  return (
    <ol className="qapaqQapaqzito__timeline" aria-label={label}>
      {steps.map((step) => (
        <li key={step.key} data-status={step.status}>
          <span className="qapaqQapaqzito__timelineMark" aria-hidden="true" />
          <span className="qapaqQapaqzito__timelineLabel">{step.label}</span>
          <span className="qapaqQapaqzito__timelineStatus">{STATUS_LABEL[step.status]}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Actividad en vivo como una línea plegable (al estilo ChatGPT/Codex). Se muestra desplegada
 * mientras Qapaqzito trabaja; al llegar la respuesta se sustituye por `QapaqzitoActivity`, ya plegada.
 */
export function QapaqzitoThinking({
  events,
  elapsedSeconds,
}: {
  readonly events: readonly QapaqzitoProgressEvent[];
  readonly elapsedSeconds: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const steps = qapaqzitoProgressTimeline(events);
  const jsonFallback = events.some((event) => event.type === 'transport_fallback');
  return (
    <div className="qapaqQapaqzito__thinking" aria-live="off">
      <button
        type="button"
        className="qapaqQapaqzito__thinkingHead"
        aria-expanded={expanded}
        aria-controls="qapaq-qapaqzito-live-activity"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="qapaqQapaqzito__thinkingPulse" aria-hidden="true" />
        <span aria-label={`Trabajando. Tiempo transcurrido: ${elapsedLabel(elapsedSeconds)}`}>
          {activitySummary({ tools: toolCount(steps), seconds: elapsedSeconds, live: true })}
        </span>
        <span className={`qapaqQapaqzito__chevron${expanded ? ' is-open' : ''}`}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {expanded && (
        <div id="qapaq-qapaqzito-live-activity" className="qapaqQapaqzito__thinkingBody">
          {steps.length === 0 ? (
            <p className="qapaqQapaqzito__thinkingWaiting" role="status" aria-live="polite">
              {jsonFallback
                ? 'El proxy no admite el canal de actividad; esperando la respuesta completa del servicio.'
                : 'Esperando la primera actualización de actividad del servidor…'}
            </p>
          ) : (
            <div role="log" aria-live="polite" aria-relevant="additions text">
              <StepList steps={steps} label="Actividad recibida del servidor" />
            </div>
          )}
          <p className="qapaqQapaqzito__thinkingNote">
            Solo se muestran las actualizaciones que envía Qapaqzito; no se estima el avance.
          </p>
        </div>
      )}
    </div>
  );
}

/** Actividad de una respuesta ya completa (o del historial): plegada por defecto. */
export function QapaqzitoActivity({
  steps,
  seconds,
}: {
  readonly steps?: readonly { readonly label: string; readonly ok: boolean }[];
  readonly seconds?: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!steps || steps.length === 0) return null;
  const timeline: QapaqzitoProgressStep[] = steps.map((step, index) => ({
    key: `tool:${step.label}:${index}`,
    label: step.label,
    status: step.ok ? 'complete' : 'no-result',
  }));
  return (
    <div className="qapaqQapaqzito__activity">
      <button
        type="button"
        className="qapaqQapaqzito__activityHead"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{activitySummary({ tools: timeline.length, seconds, live: false })}</span>
        <span className={`qapaqQapaqzito__chevron${expanded ? ' is-open' : ''}`}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {expanded && <StepList steps={timeline} label="Actividad de la consulta" />}
    </div>
  );
}
