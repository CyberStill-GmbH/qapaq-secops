import { pathToFileURL } from 'node:url';
import { ConfigurationError, SecretProviderError } from '@qapaq/configuration';
import { buildApi } from './bootstrap.js';

function log(
  event: string,
  errorCode?: string,
  fields: Readonly<Record<string, string>> = {},
): void {
  process.stdout.write(
    `${JSON.stringify({
      service: 'qapaq-secops-api',
      event,
      timestamp: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {}),
      ...fields,
    })}\n`,
  );
}

export async function main(): Promise<void> {
  let runtime: Awaited<ReturnType<typeof buildApi>> | undefined;
  let failureReported = false;
  const fail = (error: unknown, fallback: string) => {
    process.exitCode = 1;
    runtime?.lifecycle.fail();
    if (!failureReported) {
      failureReported = true;
      log(
        'application.failed',
        error instanceof ConfigurationError || error instanceof SecretProviderError
          ? error.code
          : fallback,
      );
    }
  };
  let closing: Promise<void> | undefined;
  const cleanup = () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
  const shutdown = () =>
    (closing ??= (async () => {
      // Solo este límite del ejecutable puede forzar la salida si el cierre se bloquea o falla.
      const deadline = setTimeout(() => {
        fail(undefined, 'SHUTDOWN_TIMEOUT');
        process.exit(1);
      }, 6_000);
      try {
        await runtime?.stop();
      } catch (error) {
        fail(error, 'SHUTDOWN_FAILED');
      } finally {
        clearTimeout(deadline);
        cleanup();
      }
      if (process.exitCode === 1) process.exit(1);
    })());
  const onSignal = () => {
    void shutdown();
  };
  const onException = (error: unknown) => {
    fail(error, 'UNCAUGHT_EXCEPTION');
    void shutdown();
  };
  const onRejection = (error: unknown) => {
    fail(error, 'UNHANDLED_REJECTION');
    void shutdown();
  };
  try {
    const demoMfaExceptionUntilRaw = process.env.QAPAQ_DEMO_MFA_EXCEPTION_UNTIL;
    const demoMfaExceptionUntil = demoMfaExceptionUntilRaw
      ? new Date(demoMfaExceptionUntilRaw)
      : undefined;
    runtime = await buildApi(
      process.env,
      (state) => log(`application.${state}`),
      // Solo el tipo de error: el mensaje podría citar datos del destino o de la alerta.
      (error) =>
        log('soar.dispatch.failed', error instanceof Error ? error.name : 'DISPATCH_FAILED'),
      () => ({
        uptimeSeconds: process.uptime(),
        memoryRssBytes: process.memoryUsage().rss,
        nodeVersion: process.version,
      }),
      // Solo el código del catálogo (p. ej. PROVIDER_TIMEOUT): nunca el mensaje del proveedor.
      (error) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        log('ingestion.pass.failed', typeof code === 'string' ? code : 'INGESTION_FAILED');
      },
      // Padrón: solo el código (p. ej. DIRECTORY_FORBIDDEN = falta consentimiento de Graph).
      (error) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        log('directory.sync.failed', typeof code === 'string' ? code : 'DIRECTORY_FAILED');
      },
      demoMfaExceptionUntil,
      // Motivo técnico del rechazo, buscable por el correlationId que ve la persona en la URL.
      (diagnostic) =>
        log('auth.sign_in.denied', diagnostic.reason, {
          stage: diagnostic.stage,
          correlationId: diagnostic.correlationId,
          ...(diagnostic.code ? { detail: diagnostic.code } : {}),
        }),
    );
    // Solo el modo (`memory` o `postgres`), nunca datos de conexión.
    log(`soc.persistence.${runtime.persistence}`);
    log(`ingestion.source.${runtime.ingestion}`);
    log(`enrichment.file_reputation.${runtime.fileReputation}`);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    await runtime.start();
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
        ? 'PORT_IN_USE'
        : 'BOOTSTRAP_FAILED';
    fail(error, code);
    await shutdown();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
