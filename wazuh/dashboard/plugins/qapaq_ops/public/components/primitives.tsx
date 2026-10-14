/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EuiButtonEmpty, EuiCallOut, EuiText, EuiToolTip } from '@elastic/eui';
import {
  HEALTH_TONE,
  HealthTone,
  IncidentSeverity,
  Priority,
  PRIORITY_STEP,
  SEVERITY_LABEL,
  SEVERITY_STEP,
} from '../../common';
import { QapaqApiError } from '../api/client';

/** Prioridad de alerta: glifo + color + rótulo del backend (doc 02 §2.5). */
export function PriorityMark({ priority }: { priority: Priority }) {
  const step = PRIORITY_STEP[priority];
  return (
    <span className="qapaqSeverity" data-step={step.step}>
      <span aria-hidden="true" className="qapaqSeverity__glyph" style={{ color: step.color }}>
        {step.glyph}
      </span>
      <span className="qapaqSeverity__label">{priority}</span>
    </span>
  );
}

export function SeverityMark({ severity }: { severity: IncidentSeverity }) {
  const step = SEVERITY_STEP[severity];
  return (
    <span className="qapaqSeverity" data-step={step.step}>
      <span aria-hidden="true" className="qapaqSeverity__glyph" style={{ color: step.color }}>
        {step.glyph}
      </span>
      <span className="qapaqSeverity__label">{SEVERITY_LABEL[severity]}</span>
    </span>
  );
}

/** HealthMark del login: círculo de 15 px con símbolo; único idioma de salud. */
export function HealthMark({ tone, label }: { tone: HealthTone; label: string }) {
  const mark = HEALTH_TONE[tone];
  return (
    <span className="qapaqHealth">
      <span
        aria-hidden="true"
        className="qapaqHealth__mark"
        style={{ color: mark.color, borderColor: mark.color }}
      >
        {mark.glyph}
      </span>
      <span>{label}</span>
    </span>
  );
}

/** Lo que se copia (IDs, hashes, IPs) va en mono. */
export function Mono({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <code className="qapaqMono" title={title} data-qapaq-no-translate="">
      {children}
    </code>
  );
}

// `dateStyle`/`timeStyle` no se combinan con `timeZoneName`: campos explícitos.
const ABSOLUTE = new Intl.DateTimeFormat('es-PE', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
});
const RELATIVE = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return RELATIVE.format(seconds, 'second');
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), 'hour');
  return RELATIVE.format(Math.round(seconds / 86400), 'day');
}

/** Instante relativo con la marca absoluta y la zona horaria siempre disponibles. */
export function Timestamp({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="qapaqMuted">Sin dato</span>;
  const absolute = ABSOLUTE.format(new Date(iso));
  return (
    <EuiToolTip content={absolute}>
      <time dateTime={iso} className="qapaqTabular" tabIndex={0} data-qapaq-no-translate="">
        {relativeTime(iso)}
      </time>
    </EuiToolTip>
  );
}

/** Estado vacío: una línea que explica por qué y qué hacer (A10, sin ilustraciones). */
export function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <EuiText size="s" color="subdued" className="qapaqEmpty">
      <p>{children}</p>
    </EuiText>
  );
}

export function ErrorCallout({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof QapaqApiError ? error : null;
  const degraded = apiError?.code === 'DEPENDENCY_DEGRADED';
  return (
    <EuiCallOut
      color={degraded ? 'warning' : 'danger'}
      iconType={degraded ? 'alert' : 'cross'}
      title={apiError?.message ?? 'Ocurrió un problema inesperado. El equipo ya fue notificado.'}
      size="s"
    >
      {apiError?.correlationId && (
        <p>
          Referencia: <Mono>{apiError.correlationId}</Mono>
        </p>
      )}
      {onRetry && (
        <EuiButtonEmpty size="xs" onClick={onRetry} flush="left">
          Reintentar
        </EuiButtonEmpty>
      )}
    </EuiCallOut>
  );
}

export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
}

/** Carga con cancelación: una respuesta tardía de una consulta anterior no pisa la nueva. */
export function useAsync<T>(load: () => Promise<T>, deps: React.DependencyList): AsyncState<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const generation = useRef(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    const current = ++generation.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    load().then(
      (data) => {
        if (generation.current === current) setState({ data, error: null, loading: false });
      },
      (error) => {
        if (generation.current === current) setState({ data: null, error, loading: false });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { ...state, reload };
}

/**
 * Zona de datos (títulos de alertas, entidades, notas, JSON): el traductor de `qapaq_i18n`
 * no la toca. Los textos propios de QAPAQ ya están en español.
 */
export function DataZone({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className} data-qapaq-no-translate="">
      {children}
    </div>
  );
}

/** Ancho de pantalla móvil (≤ 767 px, breakpoint `s` de OUI): flyouts y formularios a pantalla completa. */
export function useIsMobile(): boolean {
  const query = '(max-width: 767px)';
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMobile(event.matches);
    // Safari < 14 solo conoce addListener/removeListener.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', listener);
      return () => media.removeEventListener('change', listener);
    }
    media.addListener(listener);
    return () => media.removeListener(listener);
  }, []);
  return mobile;
}
