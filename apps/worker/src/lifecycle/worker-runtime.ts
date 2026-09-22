import { MessageChannel, type MessagePort } from 'node:worker_threads';

export type WorkerState = 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';
export type WorkerEvent = (state: WorkerState) => void;

/** Control de admisión inactivo. Un MessagePort referenciado espera sin sondeo ni temporizadores. */
export class WorkerRuntime {
  #state: WorkerState = 'starting';
  #ports: [MessagePort, MessagePort] | undefined;
  #shutdown: Promise<void> | undefined;
  #active = new Set<Promise<unknown>>();

  public constructor(
    private readonly emit: WorkerEvent,
    private readonly timeoutMs = 5_000,
  ) {}
  public get state(): WorkerState {
    return this.#state;
  }
  public get ready(): boolean {
    return this.#state === 'ready';
  }

  public start(): void {
    if (this.#state !== 'starting') throw new Error('WORKER_START_INVALID');
    try {
      const { port1, port2 } = new MessageChannel();
      this.#ports = [port1, port2];
      port1.start();
      port1.ref();
      this.#state = 'ready';
      this.emit('ready');
    } catch (error) {
      this.fail();
      throw error;
    }
  }

  /** Los consumidores futuros aportarán trabajo real; C-02 no envía tareas ficticias. */
  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (!this.ready) throw new Error('WORKER_NOT_READY');
    const active = Promise.resolve().then(task);
    this.#active.add(active);
    try {
      return await active;
    } finally {
      this.#active.delete(active);
    }
  }

  public fail(): void {
    if (this.#state !== 'stopped') this.#state = 'failed';
  }

  public stop(): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    if (this.#state !== 'failed') {
      this.#state = 'draining';
      this.emit('draining');
    }
    this.#shutdown = this.drain();
    return this.#shutdown;
  }

  private async drain(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.#active),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), this.timeoutMs);
        }),
      ]);
      if (this.#state !== 'failed') {
        this.#state = 'stopped';
        this.emit('stopped');
      }
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      clearTimeout(deadline);
      this.#ports?.forEach((port) => port.close());
      this.#ports = undefined;
    }
  }
}
