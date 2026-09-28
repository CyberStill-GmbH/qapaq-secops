export type ApiState = 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';
export type ApiEvent = (state: ApiState) => void;

/** Ciclo de vida HTTP: C-01 no tiene un paquete compartido para gestionar la ejecución. */
export class ApiLifecycle {
  #state: ApiState = 'starting';
  #closing: Promise<void> | undefined;
  public constructor(private readonly emit: ApiEvent) {}
  public get state(): ApiState {
    return this.#state;
  }
  public get ready(): boolean {
    return this.#state === 'ready';
  }
  public markReady(): void {
    if (this.#state !== 'starting') throw new Error('STARTUP_CANCELLED');
    this.#state = 'ready';
    this.emit('ready');
  }
  public fail(): void {
    if (this.#state !== 'stopped') this.#state = 'failed';
  }
  public shutdown(close: () => Promise<void>, timeoutMs: number): Promise<void> {
    if (this.#closing) return this.#closing;
    const alreadyFailed = this.#state === 'failed';
    if (!alreadyFailed) {
      this.#state = 'draining';
      this.emit('draining');
    }
    this.#closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(close),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), timeoutMs);
          }),
        ]);
        if (!alreadyFailed && this.#state !== 'failed') {
          this.#state = 'stopped';
          this.emit('stopped');
        }
      } catch (error) {
        this.fail();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return this.#closing;
  }
}
