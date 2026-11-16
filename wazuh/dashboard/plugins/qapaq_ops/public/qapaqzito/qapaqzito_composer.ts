/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

/** Lógica pura del cuadro de mensaje: tecla, altura automática y si se puede enviar. */

export interface ComposerKeyEvent {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  /** `true` mientras un IME (japonés, chino…) compone texto: Enter confirma la composición. */
  readonly isComposing?: boolean;
}

export type ComposerKeyAction = 'send' | 'newline' | 'none';

/**
 * Enter envía, Shift+Enter inserta salto de línea (comportamiento nativo del textarea); Enter
 * durante una composición IME nunca envía.
 */
export function composerKeyAction(event: ComposerKeyEvent): ComposerKeyAction {
  if (event.key !== 'Enter') return 'none';
  if (event.isComposing) return 'none';
  if (event.shiftKey) return 'newline';
  if (event.altKey || event.ctrlKey || event.metaKey) return 'none';
  return 'send';
}

export const COMPOSER_MAX_LINES = 8;
export const COMPOSER_LINE_HEIGHT = 22;

/** Altura del textarea según su contenido, hasta `maxLines` líneas (luego scroll interno). */
export function composerHeight(
  scrollHeight: number,
  options: { lineHeight?: number; maxLines?: number; verticalPadding?: number } = {},
): { height: number; overflow: boolean } {
  const lineHeight = options.lineHeight ?? COMPOSER_LINE_HEIGHT;
  const padding = options.verticalPadding ?? 0;
  const min = lineHeight + padding;
  const max = lineHeight * (options.maxLines ?? COMPOSER_MAX_LINES) + padding;
  const safe = Number.isFinite(scrollHeight) ? scrollHeight : min;
  return { height: Math.min(max, Math.max(min, Math.ceil(safe))), overflow: safe > max };
}

export function canSendDraft(draft: string, pending: boolean): boolean {
  return !pending && draft.trim() !== '';
}
