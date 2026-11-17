/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import {
  canSendDraft,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  composerHeight,
  composerKeyAction,
} from './qapaqzito_composer';

describe('teclas del cuadro de mensaje', () => {
  it('Enter envía; Shift+Enter deja el salto de línea nativo', () => {
    expect(composerKeyAction({ key: 'Enter' })).toBe('send');
    expect(composerKeyAction({ key: 'Enter', shiftKey: true })).toBe('newline');
  });

  it('no envía mientras un IME compone texto ni con otros modificadores', () => {
    expect(composerKeyAction({ key: 'Enter', isComposing: true })).toBe('none');
    expect(composerKeyAction({ key: 'Enter', ctrlKey: true })).toBe('none');
    expect(composerKeyAction({ key: 'a' })).toBe('none');
  });

  it('solo se envía con texto y sin una consulta en curso', () => {
    expect(canSendDraft('hola', false)).toBe(true);
    expect(canSendDraft('   ', false)).toBe(false);
    expect(canSendDraft('hola', true)).toBe(false);
  });
});

describe('altura automática', () => {
  it('crece con el contenido hasta 8 líneas y luego hace scroll', () => {
    expect(composerHeight(10)).toEqual({ height: COMPOSER_LINE_HEIGHT, overflow: false });
    expect(composerHeight(66)).toEqual({ height: 66, overflow: false });
    const max = COMPOSER_LINE_HEIGHT * COMPOSER_MAX_LINES;
    expect(composerHeight(max)).toEqual({ height: max, overflow: false });
    expect(composerHeight(max + 40)).toEqual({ height: max, overflow: true });
    expect(composerHeight(Number.NaN).height).toBe(COMPOSER_LINE_HEIGHT);
  });
});
