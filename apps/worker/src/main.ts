import { pathToFileURL } from 'node:url';
import { ConfigurationError } from '@qapaq/configuration';
import { buildWorker } from './bootstrap.js';

export function main(): void {
  let worker: ReturnType<typeof buildWorker> | undefined;
  let failureReported = false;
  let closing: Promise<void> | undefined;
  const report = (state: string, errorCode?: string) => {
    process.stdout.write(
      `${JSON.stringify({
        event: `application.${state}`,
        service: 'qapaq-secops-worker',
        timestamp: new Date().toISOString(),
        ...(errorCode ? { errorCode } : {}),
      })}\n`,
    );
  };
  const fail = (error: unknown, code: string) => {
    process.exitCode = 1;
    worker?.fail();
    if (!failureReported) {
      failureReported = true;
      report('failed', error instanceof ConfigurationError ? error.code : code);
    }
  };
  const stop = () =>
    (closing ??= (async () => {
      const deadline = setTimeout(() => {
        fail(undefined, 'SHUTDOWN_TIMEOUT');
        process.exit(1);
      }, 6_000);
      try {
        await worker?.stop();
      } catch (error) {
        fail(error, 'SHUTDOWN_FAILED');
      } finally {
        clearTimeout(deadline);
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
        process.off('uncaughtException', onException);
        process.off('unhandledRejection', onRejection);
      }
      if (process.exitCode === 1) process.exit(1);
    })());
  const onSignal = () => {
    void stop();
  };
  const onException = (error: unknown) => {
    fail(error, 'UNCAUGHT_EXCEPTION');
    void stop();
  };
  const onRejection = (error: unknown) => {
    fail(error, 'UNHANDLED_REJECTION');
    void stop();
  };
  try {
    worker = buildWorker(process.env, report);
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    worker.start();
  } catch (error) {
    fail(error, 'BOOTSTRAP_FAILED');
    void stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
