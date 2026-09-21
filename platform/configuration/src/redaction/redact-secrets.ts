import { SecretValue } from '../configuration.types.js';
import { CONFIGURATION_LIMITS, REDACTED_VALUE } from '../limits.js';
import { SENSITIVE_KEY_PATTERN } from './sensitive-keys.js';

interface RedactionState {
  properties: number;
  readonly seen: WeakMap<object, unknown>;
  readonly resolvedSecrets: readonly string[];
}

function redactString(value: string, resolvedSecrets: readonly string[]): string {
  let redacted = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    `$1${REDACTED_VALUE}@`,
  );
  for (const secret of resolvedSecrets) {
    if (secret !== '') redacted = redacted.replaceAll(secret, REDACTED_VALUE);
  }
  return redacted;
}

function visit(value: unknown, state: RedactionState, depth: number, sensitive = false): unknown {
  if (sensitive || value instanceof SecretValue) return REDACTED_VALUE;
  if (typeof value === 'string') return redactString(value, state.resolvedSecrets);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (depth >= CONFIGURATION_LIMITS.redactionMaximumDepth) return '[MAX_DEPTH]';
  const previous = state.seen.get(value);
  if (previous !== undefined) return '[CIRCULAR]';

  const output: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : Object.create(null);
  state.seen.set(value, output);
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return '[UNREADABLE]';
  }
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable) continue;
    state.properties += 1;
    if (state.properties > CONFIGURATION_LIMITS.redactionMaximumProperties)
      return '[MAX_PROPERTIES]';
    const child = !('value' in descriptor)
      ? '[ACCESSOR]'
      : visit(descriptor.value, state, depth + 1, SENSITIVE_KEY_PATTERN.test(key));
    if (Array.isArray(output)) output.push(child);
    else output[key] = child;
  }
  return output;
}

export function redactSecrets(value: unknown, resolvedSecrets: readonly string[] = []): unknown {
  return visit(value, { properties: 0, seen: new WeakMap(), resolvedSecrets }, 0);
}
