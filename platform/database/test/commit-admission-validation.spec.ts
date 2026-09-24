import { describe, expect, it } from 'vitest';
import {
  AdmissionError,
  validateAdmissionCommand,
  type AdmissionCommand,
} from '../src/commit-admission.js';
import { admissionCommandFixture, fixtureId } from './fixtures.js';

function expectRejected(mutate: (command: AdmissionCommand) => unknown): void {
  const { command } = admissionCommandFixture();
  const invalid = (mutate(command) ?? command) as AdmissionCommand;
  let thrown: unknown;
  try {
    validateAdmissionCommand(invalid);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AdmissionError);
  expect((thrown as AdmissionError).code).toBe('PERSISTENCE_CONSTRAINT_VIOLATION');
}

describe('validateAdmissionCommand: identidad, pertenencia y límites', () => {
  it('acepta un comando bien formado sin lanzar', () => {
    const { command } = admissionCommandFixture();
    expect(() => validateAdmissionCommand(command)).not.toThrow();
  });

  it('rechaza un sourceId que no es UUIDv7', () => {
    expectRejected((command) => ({ ...command, sourceId: 'no-es-un-uuid' }));
  });

  it('rechaza un manifestId que no es UUIDv7', () => {
    expectRejected((command) => ({ ...command, manifestId: 'tampoco-un-uuid' }));
  });

  it('rechaza un lote vacío de eventos', () => {
    expectRejected((command) => ({ ...command, events: [] }));
  });

  it('rechaza un lote con más de 500 eventos', () => {
    expectRejected((command) => {
      const events = Array.from({ length: 501 }, () => ({
        ...command.events[0]!,
        id: fixtureId(),
        recordId: fixtureId(),
        idempotencyKey: fixtureId(),
      }));
      return { ...command, events };
    });
  });

  it('rechaza eventos duplicados por id dentro del mismo comando', () => {
    expectRejected((command) => ({
      ...command,
      events: [command.events[0]!, { ...command.events[0]! }],
    }));
  });

  it('rechaza eventos con el mismo recordId dentro del mismo comando', () => {
    expectRejected((command) => ({
      ...command,
      events: [
        command.events[0]!,
        { ...command.events[0]!, id: fixtureId(), idempotencyKey: fixtureId() },
      ],
    }));
  });

  it('rechaza eventos con la misma idempotencyKey dentro del mismo comando', () => {
    expectRejected((command) => ({
      ...command,
      events: [
        command.events[0]!,
        { ...command.events[0]!, id: fixtureId(), recordId: fixtureId() },
      ],
    }));
  });

  it('rechaza un rawReferenceId con formato inválido', () => {
    expectRejected((command) => ({
      ...command,
      events: [{ ...command.events[0]!, rawReferenceId: 'ref-invalida' }],
    }));
  });

  it('rechaza un objeto raw que excede el límite individual de 262144 bytes', () => {
    expectRejected((command) => ({
      ...command,
      newRawObjects: [{ ...command.newRawObjects[0]!, sizeBytes: 262_145 }],
    }));
  });

  it('rechaza un sha256 con formato inválido', () => {
    expectRejected((command) => ({
      ...command,
      newRawObjects: [{ ...command.newRawObjects[0]!, sha256: 'no-es-hex-256' }],
    }));
  });

  it('rechaza un lote cuyos objetos raw superan el límite de 5 MiB combinados', () => {
    expectRejected((command) => {
      const rawCount = 21; // 21 * 262144 bytes > 5 * 1024 * 1024
      const newRawObjects = Array.from({ length: rawCount }, () => ({
        ...command.newRawObjects[0]!,
        id: fixtureId(),
        objectRef: `raw:${fixtureId()}`,
        sizeBytes: 262_144,
      }));
      const events = newRawObjects.map((raw) => ({
        ...command.events[0]!,
        id: fixtureId(),
        recordId: fixtureId(),
        idempotencyKey: fixtureId(),
        rawReferenceId: raw.id,
      }));
      return { ...command, newRawObjects, events };
    });
  });

  it('rechaza newRawObjects con más entradas que eventos', () => {
    expectRejected((command) => ({
      ...command,
      newRawObjects: [
        command.newRawObjects[0]!,
        { ...command.newRawObjects[0]!, id: fixtureId(), objectRef: `raw:${fixtureId()}` },
      ],
    }));
  });

  it('rechaza cursor presente sin expectedRevision', () => {
    expectRejected((command) => ({ ...command, expectedRevision: undefined }));
  });

  it('rechaza expectedRevision presente sin cursor', () => {
    expectRejected((command) => ({ ...command, cursor: null }));
  });

  it('rechaza expectedRevision negativo', () => {
    expectRejected((command) => ({ ...command, expectedRevision: -1n }));
  });

  it('rechaza un cursor.to vacío', () => {
    expectRejected((command) => ({ ...command, cursor: { ...command.cursor!, to: '' } }));
  });

  it('rechaza una idempotencyKey vacía', () => {
    expectRejected((command) => ({
      ...command,
      events: [{ ...command.events[0]!, idempotencyKey: '' }],
    }));
  });
});
