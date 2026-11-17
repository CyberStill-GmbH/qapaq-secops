/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 *
 * Piezas visuales compartidas por las pestañas del Analista IA.
 */

import React from 'react';
import {
  AI_CONFIDENCE_LABEL,
  AiRunSummary,
  confidenceLabel,
  HEALTH_TONE,
  verdictLabel,
} from '../../common';
import { confidenceStep, reasonText, verdictTone } from './ai_analyst_model';

/**
 * Código del backend en lenguaje llano. Uno conocido muestra solo el texto (el código queda en el
 * `title` para soporte); uno desconocido se muestra como etiqueta pequeña y apagada.
 */
export function ReasonTag({ code }: { code: string }) {
  const text = reasonText(code);
  if (text) {
    return (
      <span className="qapaqAiReason" title={code}>
        {text}
      </span>
    );
  }
  return (
    <code className="qapaqAiCode" title="Código sin descripción en esta consola" data-qapaq-no-translate="">
      {code}
    </code>
  );
}

/** Veredicto con color + glifo (nunca solo color). */
export function VerdictBadge({
  verdict,
  size = 's',
}: {
  verdict: AiRunSummary['verdict'];
  size?: 's' | 'l';
}) {
  const tone = verdictTone(verdict);
  const mark = HEALTH_TONE[tone];
  return (
    <span className="qapaqAiVerdict" data-tone={tone} data-size={size}>
      <span aria-hidden="true" className="qapaqAiVerdict__glyph">
        {mark.glyph}
      </span>
      {verdictLabel(verdict)}
    </span>
  );
}

/** Confianza en tres escalones; el rótulo siempre acompaña a las barras. */
export function ConfidenceMeter({ confidence }: { confidence: AiRunSummary['confidence'] }) {
  const step = confidenceStep(confidence);
  return (
    <span className="qapaqAiConfidence" data-step={step}>
      <span className="qapaqAiConfidence__bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        {confidence === 'unknown' ? AI_CONFIDENCE_LABEL.unknown : confidenceLabel(confidence)}
      </span>
    </span>
  );
}

/** Aviso de opción con riesgo: qué pasa si se activa, en una frase. */
export function RiskFlag({ children }: { children: React.ReactNode }) {
  return (
    <p className="qapaqAiRisk">
      <span className="qapaqAiRisk__badge">Riesgo alto</span>
      <span>{children}</span>
    </p>
  );
}

/** Cifra destacada con rótulo y pie, en el idioma visual de los KPI del Resumen del SOC. */
export function AiTile({
  label,
  value,
  hint,
  tone,
  onClick,
  children,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'ok' | 'warn' | 'fail' | 'neutral' | 'info';
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="qapaqAiTile__label">{label}</span>
      <span className="qapaqAiTile__value qapaqTabular">{value}</span>
      {children}
      {hint && <span className="qapaqAiTile__hint">{hint}</span>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="qapaqAiTile" data-tone={tone} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <div className="qapaqAiTile" data-tone={tone}>
      {body}
    </div>
  );
}
