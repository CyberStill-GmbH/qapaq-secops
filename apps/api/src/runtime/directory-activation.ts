/**
 * Activación diferida del padrón del grupo de admisión (Accesos_SOC).
 *
 * El despliegue puede declarar el grupo por nombre (`QAPAQ_DIRECTORY_GROUP_NAME`). Resolverlo exige
 * el permiso de aplicación `GroupMember.Read.All` (o `Group.Read.All`) con consentimiento de
 * administrador. Antes, el nombre se resolvía una sola vez al arrancar: sin permiso, el padrón
 * quedaba apagado hasta reiniciar el API. Ahora:
 *
 * - Se intenta una vez al arrancar, con tiempo acotado (el SOC nunca espera a Graph).
 * - Si falla, se reintenta en segundo plano con espera exponencial (1 min → 30 min por defecto).
 *   En cuanto Entra concede el permiso, el grupo se resuelve solo y `onResolved` arranca la
 *   sincronización: no hace falta reiniciar.
 * - Mientras tanto expone el estado (`pending`, último código y fecha) para que la consola
 *   muestre «permiso faltante» en lugar de un error genérico.
 *
 * Solo registra códigos (`DirectoryError.code`), nunca tokens ni respuestas de Graph.
 */

import { DirectoryError, type DirectoryDiagnostic } from '@qapaq/access';

export interface DirectoryGroupActivationOptions {
  /** Grupo ya conocido (`QAPAQ_DIRECTORY_GROUP_ID`): queda resuelto desde el inicio. */
  readonly groupId?: string;
  /** Nombre exacto a resolver si no hay ID. */
  readonly groupName?: string;
  readonly resolve?: (groupName: string) => Promise<string>;
  readonly now?: () => Date;
  readonly onResolved?: (groupId: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly attemptTimeoutMs?: number;
  readonly minimumDelayMs?: number;
  readonly maximumDelayMs?: number;
}

export interface DirectoryActivationState {
  readonly groupId: string | undefined;
  /** Código del último intento fallido (`DIRECTORY_FORBIDDEN`…); `null` si no hubo fallo. */
  readonly lastErrorCode: string | null;
  readonly diagnostic: DirectoryDiagnostic | null;
  readonly lastAttemptAt: Date | null;
  readonly nextAttemptAt: Date | null;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_MINIMUM_DELAY_MS = 60_000;
const DEFAULT_MAXIMUM_DELAY_MS = 30 * 60_000;

/** Código seguro de registrar: el de `DirectoryError` o uno genérico. */
export function directoryErrorCode(error: unknown): string {
  return error instanceof DirectoryError ? error.code : 'DIRECTORY_UNAVAILABLE';
}

export class DirectoryGroupActivation {
  #groupId: string | undefined;
  #lastErrorCode: string | null = null;
  #diagnostic: DirectoryDiagnostic | null = null;
  #lastAttemptAt: Date | null = null;
  #nextAttemptAt: Date | null = null;
  #delayMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<boolean> | undefined;
  #running = false;

  public constructor(private readonly options: DirectoryGroupActivationOptions) {
    this.#groupId = options.groupId?.toLowerCase();
    this.#delayMs = options.minimumDelayMs ?? DEFAULT_MINIMUM_DELAY_MS;
  }

  public get groupId(): string | undefined {
    return this.#groupId;
  }

  public get state(): DirectoryActivationState {
    return {
      groupId: this.#groupId,
      lastErrorCode: this.#lastErrorCode,
      diagnostic: this.#diagnostic,
      lastAttemptAt: this.#lastAttemptAt,
      nextAttemptAt: this.#nextAttemptAt,
    };
  }

  /** Un intento acotado. Devuelve si el grupo quedó resuelto. Nunca lanza. */
  public attempt(): Promise<boolean> {
    if (this.#groupId) return Promise.resolve(true);
    if (this.#inFlight) return this.#inFlight;
    const { resolve, groupName } = this.options;
    if (!resolve || !groupName) return Promise.resolve(false);
    const now = this.options.now ?? (() => new Date());
    const timeoutMs = this.options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.#inFlight = (async () => {
      this.#lastAttemptAt = now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const groupId = await Promise.race([
          resolve(groupName),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new DirectoryError('DIRECTORY_UNAVAILABLE')),
              timeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
        this.#groupId = groupId.toLowerCase();
        this.#lastErrorCode = null;
        this.#diagnostic = null;
        this.#nextAttemptAt = null;
        try {
          this.options.onResolved?.(this.#groupId);
        } catch (error) {
          this.options.onError?.(error);
        }
        return true;
      } catch (error) {
        this.#lastErrorCode = directoryErrorCode(error);
        this.#diagnostic = error instanceof DirectoryError ? (error.diagnostic ?? null) : null;
        this.options.onError?.(error);
        return false;
      } finally {
        if (timeout) clearTimeout(timeout);
        this.#inFlight = undefined;
      }
    })();
    return this.#inFlight;
  }

  /** Reintentos en segundo plano con espera exponencial hasta resolver el grupo. */
  public start(): void {
    if (this.#running || this.#groupId) return;
    this.#running = true;
    this.#schedule();
  }

  public async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#nextAttemptAt = null;
    await this.#inFlight;
  }

  #schedule(): void {
    if (!this.#running || this.#groupId) return;
    const now = this.options.now ?? (() => new Date());
    const delay = this.#delayMs;
    this.#nextAttemptAt = new Date(now().getTime() + delay);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.attempt().then((resolved) => {
        if (resolved) {
          this.#running = false;
          return;
        }
        const maximum = this.options.maximumDelayMs ?? DEFAULT_MAXIMUM_DELAY_MS;
        this.#delayMs = Math.min(this.#delayMs * 2, maximum);
        this.#schedule();
      });
    }, delay);
    this.#timer.unref?.();
  }
}
