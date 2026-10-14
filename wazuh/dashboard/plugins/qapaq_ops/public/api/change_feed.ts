/*
 * Copyright QAPAQ. SPDX-License-Identifier: Apache-2.0
 */

import { ChangeEvent, ChangesResponse } from '../../common';
import { QapaqApiError } from './client';

/**
 * Cambios en vivo desde `GET /api/changes?after=<cursor>` (long-poll de 2,5 s del BFF,
 * alimentado por la cadena de auditoría).
 *
 * Un único poller por página del dashboard (singleton del plugin), compartido por todas las
 * apps QAPAQ, sus pestañas internas y el aviso P1 de la cabecera: cambiar de vista no abre
 * otra conexión, y una pestaña del navegador oculta deja de consultar hasta volver a primer
 * plano. El feed solo dice qué
 * recurso cambió; cada vista recarga por su endpoint normal (que vuelve a autorizar).
 */

export type ChangeListener = (changes: readonly ChangeEvent[], resync: boolean) => void;

export interface ChangeSource {
  get(path: string, query?: Record<string, string | undefined>): Promise<ChangesResponse>;
}

export interface ChangeFeedOptions {
  /** Pausa tras un fallo; se duplica hasta `maxBackoffMs`. */
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly isHidden?: () => boolean;
  readonly onVisible?: (resume: () => void) => () => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ChangeFeed {
  private readonly listeners = new Map<
    number,
    { types: ReadonlySet<string>; listener: ChangeListener }
  >();
  private nextId = 0;
  private cursor: string | null = null;
  private running = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private detachVisibility: (() => void) | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly api: ChangeSource,
    private readonly options: ChangeFeedOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.initialBackoffMs = options.initialBackoffMs ?? 2000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;
  }

  /** Suscribe a cambios de ciertos tipos de recurso (`alert`, `incident`, `notification`…). */
  public subscribe(types: readonly string[], listener: ChangeListener): () => void {
    const id = this.nextId++;
    this.listeners.set(id, { types: new Set(types), listener });
    this.start();
    return () => {
      this.listeners.delete(id);
    };
  }

  public stop(): void {
    this.stopped = true;
    this.detachVisibility?.();
    this.wake?.();
  }

  private hidden(): boolean {
    if (this.options.isHidden) return this.options.isHidden();
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  private start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    const onVisible =
      this.options.onVisible ??
      ((resume: () => void) => {
        if (typeof document === 'undefined') return () => undefined;
        const handler = () => {
          if (document.visibilityState === 'visible') resume();
        };
        document.addEventListener('visibilitychange', handler);
        return () => document.removeEventListener('visibilitychange', handler);
      });
    this.detachVisibility = onVisible(() => this.wake?.());
    void this.loop();
  }

  private async pause(ms: number): Promise<void> {
    await Promise.race([this.sleep(ms), new Promise<void>((resolve) => (this.wake = resolve))]);
    this.wake = null;
  }

  private async waitUntilVisible(): Promise<void> {
    while (this.hidden() && !this.stopped) {
      await this.pause(60000);
    }
  }

  private async loop(): Promise<void> {
    let backoff = this.initialBackoffMs;
    while (!this.stopped) {
      if (this.listeners.size === 0) {
        await this.pause(1000);
        continue;
      }
      await this.waitUntilVisible();
      if (this.stopped) break;
      try {
        const response = await this.api.get('/changes', {
          after: this.cursor ?? undefined,
        });
        const first = this.cursor === null;
        this.cursor = response.cursor;
        backoff = this.initialBackoffMs;
        // La primera respuesta solo fija el punto de partida: la vista ya cargó su estado.
        if (!first && (response.resync || response.changes.length > 0)) {
          this.dispatch(response.changes, response.resync);
        }
      } catch (error) {
        // Sin sesión el cliente ya llevó al login; no tiene sentido seguir consultando.
        if (
          error instanceof QapaqApiError &&
          (error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED')
        ) {
          this.stopped = true;
          break;
        }
        // Un cursor que el BFF ya no acepta se reinicia desde la cabeza y se recarga todo.
        if (error instanceof QapaqApiError && error.code === 'VALIDATION_FAILED') {
          this.cursor = null;
          this.dispatch([], true);
        }
        await this.pause(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
    this.running = false;
  }

  private dispatch(changes: readonly ChangeEvent[], resync: boolean): void {
    for (const { types, listener } of this.listeners.values()) {
      const relevant = changes.filter((change) => types.has(change.resource.type));
      if (resync || relevant.length > 0) listener(relevant, resync);
    }
  }
}
