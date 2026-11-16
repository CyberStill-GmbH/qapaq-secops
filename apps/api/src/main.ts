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
      // Solo diagnósticos allowlisted de Graph: status, code, request-id y operación.
      (error) => {
        const code = (error as { code?: unknown } | undefined)?.code;
        const candidate =
          typeof error === 'object' && error !== null && 'diagnostic' in error
            ? (error as { diagnostic?: unknown }).diagnostic
            : undefined;
        const diagnostic =
          typeof candidate === 'object' && candidate !== null
            ? (candidate as {
                status?: unknown;
                operation?: unknown;
                errorCode?: unknown;
                requestId?: unknown;
              })
            : undefined;
        const safeOperation =
          typeof diagnostic?.operation === 'string' &&
          ['resolveGroupId', 'memberDelta', 'owners', 'userProfile'].includes(diagnostic.operation)
            ? diagnostic.operation
            : undefined;
        const safeErrorCode =
          typeof diagnostic?.errorCode === 'string' &&
          /^[A-Za-z0-9_.-]{1,100}$/u.test(diagnostic.errorCode)
            ? diagnostic.errorCode
            : undefined;
        const safeRequestId =
          typeof diagnostic?.requestId === 'string' &&
          /^[A-Za-z0-9_.:-]{1,128}$/u.test(diagnostic.requestId)
            ? diagnostic.requestId
            : undefined;
        log('directory.sync.failed', typeof code === 'string' ? code : 'DIRECTORY_FAILED', {
          ...(typeof diagnostic?.status === 'number' && Number.isInteger(diagnostic.status)
            ? { graphStatus: String(diagnostic.status) }
            : {}),
          ...(safeOperation ? { graphOperation: safeOperation } : {}),
          ...(safeErrorCode ? { graphErrorCode: safeErrorCode } : {}),
          ...(safeRequestId ? { graphRequestId: safeRequestId } : {}),
        });
      },
      demoMfaExceptionUntil,
      // Motivo técnico del rechazo, buscable por el correlationId que ve la persona en la URL.
      (diagnostic) =>
        log('auth.sign_in.denied', diagnostic.reason, {
          stage: diagnostic.stage,
          correlationId: diagnostic.correlationId,
          ...(diagnostic.code ? { detail: diagnostic.code } : {}),
        }),
      // Analista IA: códigos, etapas e ids ya saneados; nunca prompts ni evidencia.
      (event, fields) =>
        log(
          event,
          typeof fields['code'] === 'string' ? fields['code'] : undefined,
          Object.fromEntries(
            Object.entries(fields)
              .filter(([key]) => key !== 'code')
              .map(([key, value]) => [key, String(value)]),
          ),
        ),
    );
    // Solo el modo (`memory` o `postgres`), nunca datos de conexión.
    log(`soc.persistence.${runtime.persistence}`);
    log(`ingestion.source.${runtime.ingestion}`);
    // Una línea por canal de aviso: estado y paso de puesta en marcha pendiente. Nunca el destino.
    for (const channel of runtime.notificationChannels) {
      log(
        'notifications.channel.status',
        channel.setup === 'ready' ? undefined : `CHANNEL_SETUP_${channel.setup.toUpperCase()}`,
        {
          channel: channel.channel,
          status: channel.status,
          setup: channel.setup,
          enabled: String(channel.enabled),
          configured: String(channel.configured),
          source: channel.source,
          revision: String(channel.revision),
          initialized: channel.initialized,
          ...(channel.secretSkipped ? { secretSkipped: channel.secretSkipped } : {}),
        },
      );
    }
    if (
      !runtime.notificationChannels.some(
        (channel) => channel.channel !== 'push' && channel.enabled && channel.configured,
      )
    ) {
      log('notifications.channels.no_p1_delivery', 'NOTIFICATION_NO_P1_CHANNEL', {
        warning: 'ningún canal (Teams o correo) puede entregar un P1; solo queda la consola',
      });
    }
    // Advertencia visible: la excepción demo de contraseña rebaja la política de autenticación.
    if (runtime.demoAdminLoginUntil) {
      const until = runtime.demoAdminLoginUntil.toISOString();
      log('auth.demo_admin_password.active', undefined, {
        warning: `excepción demo de contraseña ACTIVA hasta ${until}`,
        until,
        additionalAccounts: String(runtime.demoAccountCount),
        deployment: runtime.demoAdminLoginDeployment ?? 'unknown',
      });
    }
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
