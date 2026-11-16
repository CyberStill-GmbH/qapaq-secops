/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourceHealth } from '../../common';
import { processingCount, ProcessingSummary, SubscriptionActivity } from './sources_view';

describe('actividad medida de las fuentes', () => {
  it('distingue una actividad aún no medida', () => {
    const markup = renderToStaticMarkup(<SubscriptionActivity subscriptions={null} />);

    expect(markup).toContain('aún no hay una medición disponible');
    expect(markup).not.toContain('Eventos');
  });

  it('muestra cuándo se midió, aunque un flujo tenga cero eventos', () => {
    const subscriptions: NonNullable<SourceHealth['subscriptions']> = {
      measuredAt: '2026-11-11T15:00:00.000Z',
      windowHours: 24,
      items: [{ stream: 'Audit.Exchange', lastEventAt: null, eventsInWindow: 0 }],
    };
    const markup = renderToStaticMarkup(<SubscriptionActivity subscriptions={subscriptions} />);

    expect(markup).toContain('Medida');
    expect(markup).toContain('2026-11-11T15:00:00.000Z');
    expect(markup).toContain('Audit.Exchange');
    expect(markup).toContain('0');
    expect(markup).not.toContain('aún no hay una medición disponible');
  });
});

describe('desglose del procesamiento de fuentes', () => {
  it('distingue un sondeo sin historial de las métricas históricas desconocidas', () => {
    const empty = renderToStaticMarkup(<ProcessingSummary processing={null} />);
    expect(empty).toContain('Aún no hay un sondeo registrado');

    const historical: NonNullable<SourceHealth['processing']> = {
      attemptedAt: '2026-11-11T15:00:00.000Z',
      completedAt: '2026-11-11T15:00:01.000Z',
      outcome: 'success',
      recordsSeen: 2,
      normalized: null,
      quarantined: 0,
      promoted: 1,
      duplicates: null,
      notPromoted: null,
      belowThreshold: null,
      suppressed: null,
      errorClass: null,
    };
    const markup = renderToStaticMarkup(<ProcessingSummary processing={historical} />);
    expect(markup).toContain('Documentos devueltos');
    expect(markup).toContain('no la actividad total de la fuente');
    expect(processingCount(historical.duplicates)).toBe('Sin desglose histórico');
    expect(processingCount(historical.notPromoted)).toBe('Sin desglose histórico');
    expect(processingCount(0)).toBe('0');
  });
});
