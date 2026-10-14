import { MessageChannel, type MessagePort } from 'node:worker_threads';

export type WorkerState = 'starting' | 'ready' | 'draining' | 'stopped' | 'failed';
export type WorkerEvent = (state: WorkerState, errorCode?: string) => void;

export interface WorkerResources {
  start(run: <T>(task: () => Promise<T>) => Promise<T>, fail: () => void): void;
  stop(): Promise<void>;
  close(): Promise<void>;
}

/** Control de admisión. Un MessagePort referenciado espera sin sondeo ni temporizadores. */
export class WorkerRuntime {
  #state: WorkerState = 'starting';
  #ports: [MessagePort, MessagePort] | undefined;
  #shutdown: Promise<void> | undefined;
  #active = new Set<Promise<unknown>>();

  public constructor(
    private readonly emit: WorkerEvent,
    private readonly timeoutMs = 115_000,
    private readonly resources?: WorkerResources,
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
      this.resources?.start(
        (task) => this.run(task),
        () => this.fail(),
      );
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

  public fail(errorCode?: string): void {
    if (this.#state === 'stopped' || this.#state === 'failed') return;
    this.#state = 'failed';
    this.emit('failed', errorCode);
    if (!this.#shutdown) void this.stop().catch(() => undefined);
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
    let failed = false;
    let failure: unknown;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('SHUTDOWN_TIMEOUT')), this.timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          await this.resources?.stop();
          await Promise.all(this.#active);
        })(),
        timeout,
      ]);
    } catch (error) {
      failed = true;
      failure = error;
      this.fail();
    } finally {
      // Close Queue and the shared API/Postgres pools even when stop() rejects or the drain
      // deadline expires. BullMQ/Postgres outbox leases make any interrupted job recoverable.
      try {
        const closing = this.resources?.close();
        if (closing) {
          let closeDeadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              closing,
              new Promise<never>((_, reject) => {
                closeDeadline = setTimeout(() => reject(new Error('WORKER_CLOSE_TIMEOUT')), 4_000);
              }),
            ]);
          } finally {
            clearTimeout(closeDeadline);
          }
        }
      } catch (error) {
        failed = true;
        failure ??= error;
        this.fail();
      }
      clearTimeout(deadline);
      this.#ports?.forEach((port) => port.close());
      this.#ports = undefined;
    }
    if (failed) throw failure;
    if (this.#state !== 'failed') {
      this.#state = 'stopped';
      this.emit('stopped');
    }
  }
}
