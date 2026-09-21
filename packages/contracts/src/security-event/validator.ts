import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import schema from './security-event.schema.json' with { type: 'json' };
import { SECURITY_EVENT_LIMITS, SECURITY_EVENT_SCHEMA_VERSION } from './catalogs.js';
import {
  SecurityEventContractError,
  type SecurityEventErrorCode,
  type SecurityEventValidationError,
} from './errors.js';
import type { SecurityEvent } from './types.js';

export type SecurityEventValidationResult =
  | { readonly valid: true; readonly value: SecurityEvent; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly SecurityEventValidationError[] };

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  validateFormats: true,
});
addFormatsModule.default(ajv);
const validateSchema: ValidateFunction<SecurityEvent> = ajv.compile<SecurityEvent>(schema);

const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const prohibitedContentKeys = /^(?:authorization|credential|password|payload|raw|secret|token)$/i;

interface ExtensionState {
  properties: number;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function safeKeyForPath(key: string): string {
  const printable = [...key]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    })
    .join('');
  return escapePointerSegment(printable.slice(0, SECURITY_EVENT_LIMITS.extensionKeyLength));
}

function extensionError(
  code: Extract<SecurityEventErrorCode, 'EXTENSION_LIMIT_EXCEEDED' | 'UNSAFE_EXTENSION_KEY'>,
  path: string,
  keyword: string,
  limit?: number,
): SecurityEventValidationError {
  return {
    code,
    message:
      code === 'UNSAFE_EXTENSION_KEY'
        ? 'La extensión contiene una clave no permitida.'
        : 'La extensión supera los límites de seguridad del contrato.',
    path,
    keyword,
    ...(limit === undefined ? {} : { details: { limit } }),
  };
}

function inspectExtensionValue(
  value: unknown,
  path: string,
  depth: number,
  state: ExtensionState,
  ancestors: Set<object>,
): SecurityEventValidationError | undefined {
  if (depth > SECURITY_EVENT_LIMITS.extensionDepth) {
    return extensionError(
      'EXTENSION_LIMIT_EXCEEDED',
      path,
      'maxDepth',
      SECURITY_EVENT_LIMITS.extensionDepth,
    );
  }

  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > SECURITY_EVENT_LIMITS.extensionStringLength) {
      return extensionError(
        'EXTENSION_LIMIT_EXCEEDED',
        path,
        'maxLength',
        SECURITY_EVENT_LIMITS.extensionStringLength,
      );
    }
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? undefined
      : extensionError('EXTENSION_LIMIT_EXCEEDED', path, 'jsonValue');
  }

  if (typeof value !== 'object') {
    return extensionError('EXTENSION_LIMIT_EXCEEDED', path, 'jsonValue');
  }

  if (ancestors.has(value)) {
    return extensionError('EXTENSION_LIMIT_EXCEEDED', path, 'acyclic');
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return extensionError('EXTENSION_LIMIT_EXCEEDED', path, 'jsonValue');
  }

  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    return extensionError('EXTENSION_LIMIT_EXCEEDED', path, 'jsonValue');
  }

  ancestors.add(value);
  try {
    if (isArray) {
      if (value.length > SECURITY_EVENT_LIMITS.extensionArrayItems) {
        return extensionError(
          'EXTENSION_LIMIT_EXCEEDED',
          path,
          'maxItems',
          SECURITY_EVENT_LIMITS.extensionArrayItems,
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        const error = inspectExtensionValue(
          value[index],
          `${path}/${index}`,
          depth + 1,
          state,
          ancestors,
        );
        if (error) return error;
      }
      return undefined;
    }

    let descriptors: Record<string, PropertyDescriptor>;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return extensionError('EXTENSION_LIMIT_EXCEEDED', path, 'jsonValue');
    }

    const keys = Object.keys(descriptors);
    for (const key of keys) {
      const keyPath = `${path}/${safeKeyForPath(key)}`;
      if (unsafeKeys.has(key) || prohibitedContentKeys.test(key)) {
        return extensionError('UNSAFE_EXTENSION_KEY', keyPath, 'propertyName');
      }
      if (key.length > SECURITY_EVENT_LIMITS.extensionKeyLength) {
        return extensionError(
          'EXTENSION_LIMIT_EXCEEDED',
          keyPath,
          'maxLength',
          SECURITY_EVENT_LIMITS.extensionKeyLength,
        );
      }
      state.properties += 1;
      if (state.properties > SECURITY_EVENT_LIMITS.extensionProperties) {
        return extensionError(
          'EXTENSION_LIMIT_EXCEEDED',
          path,
          'maxPropertiesTotal',
          SECURITY_EVENT_LIMITS.extensionProperties,
        );
      }
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) {
        return extensionError('EXTENSION_LIMIT_EXCEEDED', keyPath, 'jsonValue');
      }
      const error = inspectExtensionValue(descriptor.value, keyPath, depth + 1, state, ancestors);
      if (error) return error;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function inspectExtensions(input: unknown): SecurityEventValidationError | undefined {
  if (typeof input !== 'object' || input === null) return undefined;

  let extensions: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'extensions');
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) {
      return extensionError('EXTENSION_LIMIT_EXCEEDED', '/extensions', 'jsonValue');
    }
    extensions = descriptor.value;
  } catch {
    return extensionError('EXTENSION_LIMIT_EXCEEDED', '/extensions', 'jsonValue');
  }

  const error = inspectExtensionValue(extensions, '/extensions', 0, { properties: 0 }, new Set());
  if (error) return error;

  try {
    const serialized = JSON.stringify(extensions);
    if (serialized === undefined) {
      return extensionError('EXTENSION_LIMIT_EXCEEDED', '/extensions', 'jsonValue');
    }
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > SECURITY_EVENT_LIMITS.extensionBytes) {
      return extensionError(
        'EXTENSION_LIMIT_EXCEEDED',
        '/extensions',
        'maxBytes',
        SECURITY_EVENT_LIMITS.extensionBytes,
      );
    }
  } catch {
    return extensionError('EXTENSION_LIMIT_EXCEEDED', '/extensions', 'jsonValue');
  }
  return undefined;
}

function getReceivedSchemaVersion(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, 'schemaVersion');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value.slice(0, 64)
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(error: ErrorObject): string {
  if (error.keyword === 'required') {
    const missing =
      typeof error.params.missingProperty === 'string' ? error.params.missingProperty : '';
    return `${error.instancePath}/${escapePointerSegment(missing)}`;
  }
  if (error.keyword === 'additionalProperties') {
    const additional =
      typeof error.params.additionalProperty === 'string' ? error.params.additionalProperty : '';
    return `${error.instancePath}/${safeKeyForPath(additional)}`;
  }
  return error.instancePath || '/';
}

function normalizeAjvError(error: ErrorObject): SecurityEventValidationError {
  const details: Record<string, string | number | boolean> = {};
  if (typeof error.params.limit === 'number') details.limit = error.params.limit;
  return {
    code: 'SCHEMA_VALIDATION_FAILED',
    message: 'El evento de seguridad no cumple el schema 1.0.0.',
    path: normalizePath(error),
    keyword: error.keyword,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
}

function sortErrors(
  errors: readonly SecurityEventValidationError[],
): readonly SecurityEventValidationError[] {
  return Object.freeze(
    [...errors].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.keyword.localeCompare(right.keyword) ||
        left.code.localeCompare(right.code),
    ),
  );
}

export function validateSecurityEvent(input: unknown): SecurityEventValidationResult {
  const receivedVersion = getReceivedSchemaVersion(input);
  if (receivedVersion !== undefined && receivedVersion !== SECURITY_EVENT_SCHEMA_VERSION) {
    return {
      valid: false,
      errors: [
        {
          code: 'UNSUPPORTED_SCHEMA_VERSION',
          message: 'La versión del contrato SecurityEvent no es compatible.',
          path: '/schemaVersion',
          keyword: 'const',
          schemaVersion: receivedVersion,
        },
      ],
    };
  }

  const extensionFailure = inspectExtensions(input);
  if (extensionFailure) return { valid: false, errors: [extensionFailure] };

  try {
    if (validateSchema(input)) return { valid: true, value: input, errors: [] };
    const errors = (validateSchema.errors ?? []).map(normalizeAjvError);
    return { valid: false, errors: sortErrors(errors) };
  } catch {
    return {
      valid: false,
      errors: [
        {
          code: 'SCHEMA_VALIDATION_FAILED',
          message: 'No fue posible validar el evento de seguridad de forma segura.',
          path: '/',
          keyword: 'safeInput',
        },
      ],
    };
  }
}

export function isSecurityEvent(input: unknown): input is SecurityEvent {
  return validateSecurityEvent(input).valid;
}

export function parseSecurityEvent(input: unknown): SecurityEvent {
  const result = validateSecurityEvent(input);
  if (!result.valid) throw new SecurityEventContractError(result.errors);
  return result.value;
}
