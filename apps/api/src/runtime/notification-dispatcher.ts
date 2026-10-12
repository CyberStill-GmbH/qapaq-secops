/**
 * C-20 — bucle de despacho de notificaciones dentro del proceso API (decisión D-8).
 *
 * Antes el despacho solo ocurría al llamar `POST /api/notifications/drain`: un P1 no salía
 * a Teams por sí mismo. Este bucle consume la cola durable del outbox SOC cada
 * `intervalMs` y también cuando un caso de uso encola algo (`kick`).
 *
 * Propiedades:
 *
 * - **Un vuelo a la vez por proceso**: si una pasada sigue en curso, `kick` no abre otra;
 *   deja pedida una pasada más al terminar, para no perder lo encolado mientras tanto.
 * - **Varias réplicas**: no necesitan coordinarse aquí. El claim con lease de la cola evita
 *   que dos réplicas envíen el mismo mensaje a la vez, y la idempotencia del intento evita
 *   la segunda notificación si un lease venció a mitad de envío.
 * - **Un fallo no detiene el bucle**: se reporta por `onError` (sin datos del mensaje) y la
 *   siguiente pasada reintenta. Lo que no se publicó vuelve a ser reclamable al vencer su
 *   lease.
 * - **Apagado ordenado**: `stop` cancela el temporizador y espera la pasada en curso, de
 *   modo que el lease no quede tomado por un proceso que ya no existe más de lo necesario.
 *
 * Cuando el worker tenga acceso a la base, este mismo objeto se compone allí sin cambiar
 * el puerto.
 */

export interface NotificationDispatcherOptions {
  /** Una pasada: reclama un lote y lo despacha. Devuelve cuántos mensajes procesó. */
  readonly drain: () => Promise<number>;
  readonly intervalMs: number;
  readonly onError: (error: unknown) => void;
}

export class NotificationDispatcher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private pendingKick = false;
  private running = false;

  public constructor(private readonly options: NotificationDispatcherOptions) {}

  public get started(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** Pide una pasada pronto. Sin bucle iniciado (specs, arranque) no hace nada. */
  public kick(): void {
    if (!this.running) return;
    if (this.inFlight) {
      this.pendingKick = true;
      return;
    }
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
    // El bucle no debe mantener vivo el proceso si todo lo demás terminó.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.inFlight || !this.running) return;
    this.inFlight = (async () => {
      try {
        // Lotes completos se encadenan sin esperar el intervalo: vacía la cola en ráfagas.
        let processed: number;
        do {
          processed = await this.options.drain();
        } while (processed > 0 && this.running);
      } catch (error) {
        this.options.onError(error);
      }
    })();
    await this.inFlight;
    this.inFlight = undefined;
    const again = this.pendingKick;
    this.pendingKick = false;
    this.schedule(again ? 0 : this.options.intervalMs);
  }
}
