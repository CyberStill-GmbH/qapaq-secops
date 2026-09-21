import { readFile, readdir } from 'node:fs/promises';

import { compile } from 'json-schema-to-typescript';
import { describe, expect, it } from 'vitest';

import {
  EVENT_UID_TYPES,
  NORMALIZED_SEVERITIES,
  SECURITY_EVENT_CATEGORIES,
  SECURITY_EVENT_KINDS,
  SECURITY_EVENT_LIMITS,
  SECURITY_EVENT_OUTCOMES,
  SECURITY_EVENT_SCHEMA_VERSION,
  SECURITY_EVENT_SOURCE_KINDS,
  SecurityEventContractError,
  TIMESTAMP_QUALITIES,
  isSecurityEvent,
  parseSecurityEvent,
  validateSecurityEvent,
  type SecurityEvent,
  type SecurityEventValidationError,
} from '../src/index.js';
import schema from '../src/security-event/security-event.schema.json' with { type: 'json' };

const fixturesRoot = new URL('../src/security-event/fixtures/', import.meta.url);

interface InvalidFixture {
  readonly input: unknown;
  readonly expected: Pick<SecurityEventValidationError, 'code' | 'path' | 'keyword'>;
}

async function loadJsonFiles<T>(
  directory: 'valid' | 'invalid',
): Promise<ReadonlyArray<{ name: string; value: T }>> {
  const url = new URL(`${directory}/`, fixturesRoot);
  const names = (await readdir(url)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      value: JSON.parse(await readFile(new URL(name, url), 'utf8')) as T,
    })),
  );
}

function baseEvent(): SecurityEvent {
  return parseSecurityEvent({
    schemaVersion: '1.0.0',
    recordId: '01890f47-7abc-7def-8abc-0123456789ab',
    eventUid: 'synthetic:event:1',
    eventUidType: 'native',
    kind: 'event',
    occurredAt: '2026-09-20T15:30:00Z',
    observedAt: '2026-09-20T15:30:01Z',
    receivedAt: '2026-09-20T15:30:02Z',
    source: {
      kind: 'application',
      vendor: 'Synthetic Vendor',
      product: 'Synthetic Product',
      dataset: 'security-events',
      instanceId: 'synthetic-instance',
      nativeEventId: 'event-1',
    },
    tenant: { id: 'tenant-synthetic-001' },
    severity: {
      normalized: 'informational',
      score: 10,
      originalValue: 1,
      originalLabel: 'info',
      originalScale: 'synthetic-1-5',
      mappingId: 'synthetic.severity',
      mappingVersion: '1.0.0',
    },
    category: ['unclassified'],
    outcome: 'unknown',
    entities: { identities: [], resources: [] },
    raw: {
      ref: 'raw:tenant-synthetic-001/event-1',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mediaType: 'application/json',
      sizeBytes: 100,
    },
    provenance: {
      connector: 'synthetic-connector',
      connectorVersion: '1.0.0',
      parserVersion: '1.0.0',
      mappingVersion: '1.0.0',
      timestampQuality: 'source',
      ingestionPath: [{ kind: 'adapter', vendor: 'QAPAQ', product: 'QAPAQ SecOps' }],
    },
  });
}

describe('SecurityEvent 1.0.0 corpus', () => {
  it('accepts every valid fixture without mutation', async () => {
    const fixtures = await loadJsonFiles<unknown>('valid');
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures) {
      const before = structuredClone(fixture.value);
      const result = validateSecurityEvent(fixture.value);
      expect(result, fixture.name).toMatchObject({ valid: true, errors: [] });
      expect(fixture.value, fixture.name).toEqual(before);
      expect(isSecurityEvent(fixture.value), fixture.name).toBe(true);
    }
  });

  it('rejects every invalid fixture with its stable code, path and keyword', async () => {
    const fixtures = await loadJsonFiles<InvalidFixture>('invalid');
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    for (const fixture of fixtures) {
      const first = validateSecurityEvent(fixture.value.input);
      const second = validateSecurityEvent(fixture.value.input);
      const third = validateSecurityEvent(fixture.value.input);
      expect(first, fixture.name).toEqual(second);
      expect(second, fixture.name).toEqual(third);
      expect(first.valid, fixture.name).toBe(false);
      if (!first.valid) {
        expect(first.errors, fixture.name).toContainEqual(
          expect.objectContaining(fixture.value.expected),
        );
      }
    }
  });
});

describe('SecurityEvent validator behavior', () => {
  it('does not coerce values, add defaults or remove unknown properties', () => {
    const input = structuredClone(baseEvent()) as unknown as Record<string, unknown>;
    input.receivedAt = 42;
    input.unknown = true;
    const before = structuredClone(input);
    const result = validateSecurityEvent(input);
    expect(result.valid).toBe(false);
    expect(input).toEqual(before);
    expect(input.receivedAt).toBe(42);
    expect(input.unknown).toBe(true);
  });

  it('distinguishes an incompatible version from an invalid supported event', () => {
    expect(validateSecurityEvent({ schemaVersion: '2.0.0' })).toMatchObject({
      valid: false,
      errors: [{ code: 'UNSUPPORTED_SCHEMA_VERSION', path: '/schemaVersion' }],
    });
    const supported = validateSecurityEvent({ schemaVersion: '1.0.0' });
    expect(supported.valid).toBe(false);
    if (!supported.valid) {
      expect(supported.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA_VALIDATION_FAILED' })]),
      );
    }
  });

  it('requires detection.rule for alerts and permits its absence for events', () => {
    const regularEvent = structuredClone(baseEvent());
    expect(validateSecurityEvent(regularEvent).valid).toBe(true);
    const alert = { ...regularEvent, kind: 'alert' };
    const result = validateSecurityEvent(alert);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/detection', keyword: 'required' }),
        ]),
      );
    }
  });

  it('throws only the normalized public contract error from parse', () => {
    const marker = 'DO_NOT_LEAK_PAYLOAD_MARKER';
    let caught: unknown;
    try {
      parseSecurityEvent({ schemaVersion: '1.0.0', secret: marker });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecurityEventContractError);
    expect(JSON.stringify(caught)).not.toContain(marker);
  });

  it('rejects hostile and non-JSON extension values without leaking internal exceptions', () => {
    const cases: unknown[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cases.push(
      cyclic,
      { value: 1n },
      { value: Symbol('x') },
      { value: () => true },
      { value: undefined },
    );
    const getter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getter, 'value', {
      enumerable: true,
      get: () => {
        throw new Error('sensitive');
      },
    });
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('sensitive proxy');
        },
      },
    );
    cases.push(getter, hostileProxy);

    for (const extensionValue of cases) {
      const input = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
      input.extensions = { 'com.example': extensionValue };
      const result = validateSecurityEvent(input);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors[0]?.message).not.toContain('sensitive');
    }
  });

  it('accepts exact extension limits and rejects the immediately greater values', () => {
    const exactString = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    exactString.extensions = {
      'com.example': { note: 'x'.repeat(SECURITY_EVENT_LIMITS.extensionStringLength) },
    };
    expect(validateSecurityEvent(exactString).valid).toBe(true);

    const longString = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    longString.extensions = {
      'com.example': { note: 'x'.repeat(SECURITY_EVENT_LIMITS.extensionStringLength + 1) },
    };
    expect(validateSecurityEvent(longString)).toMatchObject({
      valid: false,
      errors: [{ code: 'EXTENSION_LIMIT_EXCEEDED', keyword: 'maxLength' }],
    });

    const exactArray = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    exactArray.extensions = {
      'com.example': { items: Array.from({ length: 64 }, (_, index) => index) },
    };
    expect(validateSecurityEvent(exactArray).valid).toBe(true);

    const longArray = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    longArray.extensions = {
      'com.example': { items: Array.from({ length: 65 }, (_, index) => index) },
    };
    expect(validateSecurityEvent(longArray)).toMatchObject({
      valid: false,
      errors: [{ code: 'EXTENSION_LIMIT_EXCEEDED', keyword: 'maxItems' }],
    });

    const exactProperties = structuredClone(baseEvent()) as SecurityEvent & {
      extensions?: unknown;
    };
    exactProperties.extensions = {
      'com.example': Object.fromEntries(
        Array.from({ length: 63 }, (_, index) => [`p${index}`, index]),
      ),
    };
    expect(validateSecurityEvent(exactProperties).valid).toBe(true);

    const tooManyProperties = structuredClone(baseEvent()) as SecurityEvent & {
      extensions?: unknown;
    };
    tooManyProperties.extensions = {
      'com.example': Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [`p${index}`, index]),
      ),
    };
    expect(validateSecurityEvent(tooManyProperties)).toMatchObject({
      valid: false,
      errors: [{ code: 'EXTENSION_LIMIT_EXCEEDED', keyword: 'maxPropertiesTotal' }],
    });

    const exactDepth = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    exactDepth.extensions = { 'com.example': { a: { b: { c: true } } } };
    expect(validateSecurityEvent(exactDepth).valid).toBe(true);

    const tooDeep = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    tooDeep.extensions = { 'com.example': { a: { b: { c: { d: true } } } } };
    expect(validateSecurityEvent(tooDeep)).toMatchObject({
      valid: false,
      errors: [{ code: 'EXTENSION_LIMIT_EXCEEDED', keyword: 'maxDepth' }],
    });

    const byteLimitedValue: Record<string, string> = {
      a: 'x'.repeat(4096),
      b: 'x'.repeat(4096),
      c: 'x'.repeat(4096),
      d: '',
    };
    const byteLimitedExtensions = { 'com.example': byteLimitedValue };
    const baseBytes = new TextEncoder().encode(JSON.stringify(byteLimitedExtensions)).byteLength;
    byteLimitedValue.d = 'x'.repeat(SECURITY_EVENT_LIMITS.extensionBytes - baseBytes);
    expect(new TextEncoder().encode(JSON.stringify(byteLimitedExtensions)).byteLength).toBe(
      SECURITY_EVENT_LIMITS.extensionBytes,
    );
    const exactBytes = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    exactBytes.extensions = byteLimitedExtensions;
    expect(validateSecurityEvent(exactBytes).valid).toBe(true);

    byteLimitedValue.d += 'x';
    const tooManyBytes = structuredClone(baseEvent()) as SecurityEvent & { extensions?: unknown };
    tooManyBytes.extensions = byteLimitedExtensions;
    expect(validateSecurityEvent(tooManyBytes)).toMatchObject({
      valid: false,
      errors: [{ code: 'EXTENSION_LIMIT_EXCEEDED', keyword: 'maxBytes' }],
    });
  });
});

describe('SecurityEvent schema synchronization and isolation', () => {
  it('keeps public catalogs equal to the normative schema enums', () => {
    expect(SECURITY_EVENT_SCHEMA_VERSION).toBe(schema.properties.schemaVersion.const);
    expect(SECURITY_EVENT_KINDS).toEqual(schema.properties.kind.enum);
    expect(EVENT_UID_TYPES).toEqual(schema.properties.eventUidType.enum);
    expect(NORMALIZED_SEVERITIES).toEqual(schema.$defs.severity.properties.normalized.enum);
    expect(SECURITY_EVENT_CATEGORIES).toEqual(schema.properties.category.items.enum);
    expect(SECURITY_EVENT_OUTCOMES).toEqual(schema.properties.outcome.enum);
    expect(SECURITY_EVENT_SOURCE_KINDS).toEqual(schema.$defs.source.properties.kind.enum);
    expect(TIMESTAMP_QUALITIES).toEqual(schema.$defs.provenance.properties.timestampQuality.enum);
  });

  it('keeps generated TypeScript byte-for-byte aligned with the schema', async () => {
    const generated = await compile(schema, schema.title, {
      bannerComment:
        '/* Este archivo se genera desde security-event.schema.json. No editar manualmente. */',
      enableConstEnums: false,
      unknownAny: false,
      maxItems: 0,
      style: { singleQuote: true, semi: true, trailingComma: 'all', printWidth: 100 },
    });
    const committed = await readFile(
      new URL('../src/security-event/generated.ts', import.meta.url),
      'utf8',
    );
    expect(committed.replaceAll('\r\n', '\n')).toBe(generated.replaceAll('\r\n', '\n'));
  });

  it('does not import provider or infrastructure dependencies', async () => {
    const directory = new URL('../src/security-event/', import.meta.url);
    const sourceNames = (await readdir(directory)).filter((name) => name.endsWith('.ts'));
    const source = await Promise.all(
      sourceNames.map((name) => readFile(new URL(name, directory), 'utf8')),
    );
    const forbidden = [
      /from ['"][^'"]*wazuh/i,
      /from ['"][^'"]*(?:prisma|redis|minio|opensearch|nestjs|axios|undici)/i,
      /\bWazuhRule\b/,
    ];
    for (const pattern of forbidden) expect(source.join('\n')).not.toMatch(pattern);
  });

  it('exposes the intentionally small runtime API', async () => {
    const publicApi = await import('../src/index.js');
    const contractExports = [
      'EVENT_UID_TYPES',
      'NORMALIZED_SEVERITIES',
      'SECURITY_EVENT_CATEGORIES',
      'SECURITY_EVENT_ERROR_CODES',
      'SECURITY_EVENT_KINDS',
      'SECURITY_EVENT_LIMITS',
      'SECURITY_EVENT_OUTCOMES',
      'SECURITY_EVENT_SCHEMA_VERSION',
      'SECURITY_EVENT_SOURCE_KINDS',
      'SUPPORTED_SECURITY_EVENT_VERSIONS',
      'SecurityEventContractError',
      'TIMESTAMP_QUALITIES',
      'isSecurityEvent',
      'parseSecurityEvent',
      'validateSecurityEvent',
    ];
    for (const name of contractExports) expect(publicApi).toHaveProperty(name);
    expect(publicApi).not.toHaveProperty('ajv');
    expect(publicApi).not.toHaveProperty('schema');
  });

  it('keeps fixtures synthetic and free from common secret material', async () => {
    const fixtures = [
      ...(await loadJsonFiles<unknown>('valid')),
      ...(await loadJsonFiles<InvalidFixture>('invalid')),
    ];
    const text = JSON.stringify(fixtures);
    expect(text).not.toMatch(/-----BEGIN [A-Z ]+PRIVATE KEY-----/);
    expect(text).not.toMatch(/(?:sk|ghp|eyJ)[-_A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(
      /\b(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])(?:\.(?:\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])){3}\b/,
    );
    const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    expect(emails.every((email) => email.endsWith('@example.test'))).toBe(true);
  });
});
