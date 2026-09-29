import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  SECRET_CAPABILITIES,
  SecretControlPlane,
  SecretFingerprintKey,
  SubmittedSecret,
  redactSecrets,
  type SecretAuditEvent,
  type SecretAuditSink,
  type SecretAuthorizer,
} from '../src/index.js';
import { InMemorySecretStore } from '../src/testing/in-memory-secret-store.js';
import { RecordingSecretWriter } from '../src/testing/recording-secret-writer.js';

/**
 * Centinela sintético: marcador de fuga, no una credencial. Se construye en
 * ejecución para que la suite no versione material con forma de secreto.
 */
const SENTINEL = `QAPAQ-SENTINEL-DO-NOT-LEAK-${randomBytes(12).toString('hex')}`;
const FINGERPRINT_KEY = randomBytes(32).toString('hex');
const REFERENCE = 'secret://test/sentinel-credential';
const NOW = new Date('2026-09-29T12:00:00.000Z');

const allowAll: SecretAuthorizer = { authorize: async () => true };

class CollectingAuditSink implements SecretAuditSink {
  public readonly events: SecretAuditEvent[] = [];
  public async record(event: SecretAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function context(requestId: string) {
  return {
    actor: { actorType: 'human' as const, actorId: 'platform-admin-01' },
    requestId,
    correlationId: `corr-${requestId}`,
    occurredAt: NOW,
  };
}

function build() {
  const store = new InMemorySecretStore();
  const writer = new RecordingSecretWriter();
  const sink = new CollectingAuditSink();
  const controlPlane = new SecretControlPlane({
    writer,
    store,
    authorizer: allowAll,
    auditSink: sink,
    fingerprintKey: new SecretFingerprintKey(FINGERPRINT_KEY),
  });
  return { controlPlane, store, writer, sink };
}

function serializeDeeply(value: unknown): string {
  const seen = new WeakSet<object>();
  const json = JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (typeof entry === 'bigint') return entry.toString();
      if (typeof entry === 'object' && entry !== null) {
        if (seen.has(entry)) return '[circular]';
        seen.add(entry);
      }
      return entry;
    },
    2,
  );
  return `${json ?? ''}\n${inspect(value, { depth: 12, showHidden: true, getters: true })}`;
}

async function collectSources(directory: URL): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...(await collectSources(child)));
    else if (entry.name.endsWith('.ts')) files.push(await readFile(child, 'utf8'));
  }
  return files;
}

describe('C-24 propiedades de seguridad', () => {
  describe('INV-02/INV-03 — el valor no vuelve a salir', () => {
    it('no expone ninguna operación de lectura del valor en el control plane', () => {
      const surface = Object.getOwnPropertyNames(SecretControlPlane.prototype);
      expect(surface.sort()).toEqual(
        ['constructor', 'createSecret', 'readMetadata', 'revokeSecret', 'rotateSecret'].sort(),
      );
    });

    it('no declara una capability capaz de autorizar la lectura del valor', () => {
      const capabilities = Object.values(SECRET_CAPABILITIES);
      expect(capabilities).toHaveLength(4);
      for (const capability of capabilities)
        expect(capability).not.toMatch(/read_value|reveal|export|plaintext|download/u);
      expect(capabilities).not.toContain('integration.secret.read_value');
    });

    it('el puerto de escritura no declara un método de lectura en su fuente', async () => {
      const port = await readFile(
        new URL('../src/control-plane/secret-writer.port.ts', import.meta.url),
        'utf8',
      );
      for (const forbidden of ['resolve(', 'read(', 'get(', 'reveal(', 'export('])
        expect(port).not.toContain(forbidden);
    });

    it('el control plane no importa el puerto de resolución de runtime', async () => {
      const service = await readFile(
        new URL('../src/control-plane/secret-control-plane.ts', import.meta.url),
        'utf8',
      );
      const imports = [...service.matchAll(/^import[\s\S]*?from '([^']+)';$/gmu)];
      expect(imports.length).toBeGreaterThan(0);
      for (const [statement, module] of imports) {
        expect(module).not.toContain('secret-provider.port');
        expect(statement).not.toMatch(/\bSecretProvider\b/u);
      }
    });
  });

  describe('INV-01/INV-06 — el centinela no aparece en ninguna superficie', () => {
    it('no filtra el material en respuesta, metadata, auditoría ni doble de proveedor', async () => {
      const harness = build();
      const created = await harness.controlPlane.createSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(SENTINEL),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        labels: { env: 'test' },
        context: context('req-sentinel-0001'),
      });
      const rotated = await harness.controlPlane.rotateSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(`${SENTINEL}-rotated`),
        context: context('req-sentinel-0002'),
      });
      const revoked = await harness.controlPlane.revokeSecret({
        reference: REFERENCE,
        context: context('req-sentinel-0003'),
      });

      const surfaces = serializeDeeply({
        created,
        rotated,
        revoked,
        persisted: harness.store.dump(),
        transactionalAudit: harness.store.auditTrail,
        attemptAudit: harness.sink.events,
        writerCalls: harness.writer.calls,
      });
      expect(surfaces).not.toContain(SENTINEL);
      expect(surfaces.length).toBeGreaterThan(0);
    });

    it('no filtra el material por errores de frontera ni por sus trazas', async () => {
      const cases: unknown[] = [];
      for (const failure of ['WRITER_REJECTED', 'WRITER_UNREACHABLE', 'WRITER_OUTCOME_UNKNOWN']) {
        const harness = build();
        harness.writer.failNextWith = failure as 'WRITER_REJECTED';
        await harness.controlPlane
          .createSecret({
            reference: REFERENCE,
            secret: new SubmittedSecret(SENTINEL),
            purpose: 'wazuh-indexer',
            owner: 'platform-admin',
            context: context(`req-sentinel-fail-${failure.toLowerCase()}`),
          })
          .catch((error: unknown) => {
            cases.push({
              error,
              message: error instanceof Error ? error.message : '',
              stack: error instanceof Error ? error.stack : '',
              own: error instanceof Error ? Object.getOwnPropertyDescriptors(error) : {},
            });
          });
        cases.push(harness.store.dump(), harness.sink.events);
      }
      expect(cases.length).toBeGreaterThan(0);
      expect(serializeDeeply(cases)).not.toContain(SENTINEL);
    });

    it('no filtra el material por una validación fallida posterior a la construcción', async () => {
      const harness = build();
      const secret = new SubmittedSecret(SENTINEL);
      await harness.controlPlane
        .createSecret({
          reference: REFERENCE,
          secret,
          purpose: 'INVALID PURPOSE',
          owner: 'platform-admin',
          context: context('req-sentinel-0004'),
        })
        .catch((error: unknown) => {
          expect(serializeDeeply(error)).not.toContain(SENTINEL);
        });
      expect(secret.consumed).toBe(false);
      expect(serializeDeeply(secret)).not.toContain(SENTINEL);
    });

    it('redacta el portador y la clave de fingerprint en cualquier serialización', () => {
      const secret = new SubmittedSecret(SENTINEL);
      const key = new SecretFingerprintKey(FINGERPRINT_KEY);
      expect(JSON.stringify({ secret, key })).not.toContain(SENTINEL);
      expect(JSON.stringify({ secret, key })).not.toContain(FINGERPRINT_KEY);
      expect(`${String(secret)} ${String(key)}`).toBe('[REDACTED] [REDACTED]');
      expect(inspect({ secret, key }, { depth: 6 })).not.toContain(SENTINEL);
      expect(JSON.stringify(redactSecrets({ secret, key }))).not.toContain(SENTINEL);
    });
  });

  describe('INV-07 — el fingerprint no reconstruye el material', () => {
    it('cambia con el valor, es estable para el mismo valor y no lo contiene', () => {
      const key = new SecretFingerprintKey(FINGERPRINT_KEY);
      const first = key.compute(SENTINEL);
      expect(key.compute(SENTINEL)).toBe(first);
      expect(key.compute(`${SENTINEL}x`)).not.toBe(first);
      expect(first).not.toContain(SENTINEL);
      expect(first.startsWith(`hmac-sha256:v1:${key.keyId}:`)).toBe(true);
    });

    it('produce fingerprints distintos con claves distintas para el mismo valor', () => {
      const other = new SecretFingerprintKey(randomBytes(32).toString('hex'));
      expect(other.compute(SENTINEL)).not.toBe(
        new SecretFingerprintKey(FINGERPRINT_KEY).compute(SENTINEL),
      );
    });

    it('exige una clave con longitud mínima', () => {
      expect(() => new SecretFingerprintKey('too-short')).toThrowError();
    });
  });

  describe('INV-01 — la persistencia no admite material secreto', () => {
    it('el registro durable solo contiene referencia, fingerprint y metadata', async () => {
      const harness = build();
      await harness.controlPlane.createSecret({
        reference: REFERENCE,
        secret: new SubmittedSecret(SENTINEL),
        purpose: 'wazuh-indexer',
        owner: 'platform-admin',
        context: context('req-shape-0001'),
      });
      const record = harness.store.dump().at(0);
      expect(Object.keys(record ?? {}).sort()).toEqual(
        [
          'createdAt',
          'createdBy',
          'fingerprint',
          'id',
          'labels',
          'namespace',
          'owner',
          'provider',
          'purpose',
          'reference',
          'revision',
          'status',
          'version',
        ].sort(),
      );
    });
  });

  describe('barrido estático de la superficie del componente', () => {
    it('ningún archivo del control plane introduce almacenamiento reversible', async () => {
      const sources = await collectSources(new URL('../src/control-plane/', import.meta.url));
      expect(sources.length).toBeGreaterThan(5);
      for (const source of sources) {
        expect(source).not.toMatch(/createCipheriv|createDecipheriv|\bdecrypt\b/u);
        expect(source).not.toMatch(/secretValue\s*[:=]|plaintext\s*:\s*string;?\s*\/\/ persist/u);
      }
    });

    it('ningún archivo de la aplicación expone una ruta HTTP de secretos', async () => {
      const sources = await collectSources(new URL('../../../apps/api/src/', import.meta.url));
      for (const source of sources)
        expect(source).not.toMatch(/secrets?\/[^\s'"`]*\/(value|reveal|export|download)/u);
    });
  });
});
