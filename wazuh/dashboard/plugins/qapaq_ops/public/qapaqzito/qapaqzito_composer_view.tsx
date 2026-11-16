/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import React, { useLayoutEffect } from 'react';
import { canSendDraft, composerHeight, composerKeyAction } from './qapaqzito_composer';
import { Icon } from './qapaqzito_icons';

/**
 * Cuadro de mensaje redondeado al pie: textarea que crece hasta 8 líneas, Enter envía,
 * Shift+Enter inserta salto, y el botón de enviar pasa a «Detener» mientras Qapaqzito responde.
 */
export function QapaqzitoComposer({
  draft,
  pending,
  maxChars,
  name,
  context,
  inputRef,
  onDraft,
  onSend,
  onStop,
}: {
  readonly draft: string;
  readonly pending: boolean;
  readonly maxChars: number;
  readonly name: string;
  readonly context: { readonly label: string; readonly onRemove: () => void } | null;
  readonly inputRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  readonly onDraft: (value: string) => void;
  readonly onSend: () => void;
  readonly onStop: () => void;
}) {
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const { height, overflow } = composerHeight(el.scrollHeight);
    el.style.height = `${height}px`;
    el.style.overflowY = overflow ? 'auto' : 'hidden';
  }, [draft, inputRef]);

  return (
    <form
      className="qapaqQapaqzito__composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSendDraft(draft, pending)) onSend();
      }}
    >
      <div className="qapaqQapaqzito__composerBox">
        {context && (
          <div className="qapaqQapaqzito__context" role="status">
            <Icon name="link" size={13} />
            <span>{context.label}</span>
            <button type="button" onClick={context.onRemove} aria-label="Quitar contexto">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          value={draft}
          maxLength={maxChars}
          rows={1}
          placeholder={`Pregúntale algo a ${name}…`}
          aria-label={`Escribe tu pregunta para ${name}`}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            const action = composerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              isComposing: event.nativeEvent.isComposing,
            });
            if (action === 'send') {
              event.preventDefault();
              if (canSendDraft(draft, pending)) onSend();
            }
          }}
        />
        <div className="qapaqQapaqzito__composerFoot">
          <span className="qapaqQapaqzito__composerHint">Enter envía · Shift+Enter nueva línea</span>
          {pending ? (
            <button
              type="button"
              className="qapaqQapaqzito__send is-stop"
              aria-label="Detener la consulta"
              title="Cancelar consulta"
              onClick={onStop}
            >
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="submit"
              className="qapaqQapaqzito__send"
              disabled={!canSendDraft(draft, pending)}
              aria-label="Enviar"
              title="Enviar (Enter)"
            >
              <Icon name="send" size={16} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
