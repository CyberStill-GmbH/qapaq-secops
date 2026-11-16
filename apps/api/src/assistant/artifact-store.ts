/**
 * Almacén de los archivos que genera Qapaqzito (informes) y su purga periódica.
 *
 * - Memoria en desarrollo y pruebas; PostgreSQL (`assistant_artifacts`) cuando la persistencia SOC
 *   es `postgres`. Se importa de forma diferida para que el runtime en memoria no cargue Prisma.
 * - Los archivos vencen a las 24 h: una purga periódica (y una al arrancar) borra las filas
 *   vencidas. Si falla, se reintenta en el siguiente ciclo; nunca tumba la API.
 */

import { InMemoryArtifactStore, type ArtifactStore, type ArtifactVault } from '@qapaq/assistant';

import { loadAssistantConfig } from './assistant-config.js';
import type { ConversationDatabaseConnection } from './conversation-history.js';

export type ClosableArtifactStore = ArtifactStore & { close(): Promise<void> };

/** Intervalo de la purga de archivos vencidos. */
export const ARTIFACT_PURGE_INTERVAL_MS = 10 * 60_000;

/** `undefined` si Qapaqzito está apagado; en memoria sin conexión; PostgreSQL con ella. */
export async function assistantArtifactStoreFor(
  environment: Readonly<Record<string, string | undefined>>,
  connection?: ConversationDatabaseConnection,
): Promise<ClosableArtifactStore | undefined> {
  if (!loadAssistantConfig(environment).enabled) return undefined;
  if (!connection) return new InMemoryArtifactStore();
  const { PostgresArtifactStore } = await import('@qapaq/assistant/postgres-artifacts');
  return PostgresArtifactStore.connect(connection);
}

/** Purga ahora y cada `intervalMs`; devuelve la función que detiene el temporizador. */
export function startArtifactPurge(
  vault: ArtifactVault,
  onError: (error: unknown) => void = () => undefined,
  intervalMs: number = ARTIFACT_PURGE_INTERVAL_MS,
): () => void {
  const purge = () => {
    vault.purgeExpired().catch(onError);
  };
  purge();
  const timer = setInterval(purge, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
