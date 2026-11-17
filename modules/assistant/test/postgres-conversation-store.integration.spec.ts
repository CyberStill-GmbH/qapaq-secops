/**
 * Historial de Qapaqzito en PostgreSQL real (excluido del run unitario; requiere `DATABASE_URL`).
 *
 * Fija lo que solo la base demuestra: aislamiento por (tenant, dueño) en cada consulta, el
 * tope de conversaciones por persona dentro de la transacción, el compare-and-set del turno
 * con escrituras concurrentes, los CHECK de la migración y el borrado real.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONVERSATION_LIMITS, type StoredMessage } from '../src/conversations.js';
import { PostgresConversationStore } from '../src/infrastructure/postgres-conversation-store.js';

const exec = promisify(execFile);
const databaseUrl = process.env['DATABASE_URL'];
const databaseRoot = fileURLToPath(new URL('../../../platform/database/', import.meta.url));
const removeThinkingMigration = readFileSync(
  fileURLToPath(
    new URL(
      '../../../platform/database/prisma/migrations/20261112120000_remove_qapaqzito_thinking/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);
const ANA = { tenantId: 'tenant-qapaqzito', ownerId: 'ana' };
const LUIS = { tenantId: 'tenant-qapaqzito', ownerId: 'luis' };
const BASE = Date.UTC(2026, 10, 1, 12);

let sequence = 0;
function uuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

function turn(text: string, at: Date): StoredMessage[] {
  return [
    { id: uuid(), role: 'user', text, createdAt: at },
    {
      id: uuid(),
      role: 'assistant',
      text: `r: ${text}`,
      steps: [{ tool: 'list_alerts', label: 'Buscando alertas', ok: true }],
      citations: [{ kind: 'alert', id: 'a1', label: 'Alerta' }],
      tone: 'notice',
      createdAt: at,
    },
  ];
}

describe.skipIf(!databaseUrl)('Qapaqzito · historial en PostgreSQL', () => {
  const name = `qapaq_qapaqzito_${process.pid}_${Date.now()}`.toLowerCase();
  let url: string;
  let store: PostgresConversationStore;

  beforeAll(async () => {
    const admin = new URL(databaseUrl!);
    admin.pathname = '/postgres';
    const client = new Client(admin.toString());
    await client.connect();
    await client.query(`CREATE DATABASE "${name}"`);
    await client.end();
    const target = new URL(databaseUrl!);
    target.pathname = `/${name}`;
    url = target.toString();
    await exec(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: databaseRoot,
        env: { ...process.env, DATABASE_URL: url },
        shell: process.platform === 'win32',
      },
    );
    store = PostgresConversationStore.connect({ connectionString: url, maxConnections: 4 });
  });

  afterAll(async () => {
    await store?.close();
    const admin = new URL(databaseUrl!);
    admin.pathname = '/postgres';
    const client = new Client(admin.toString());
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.end();
  });

  it('guarda y relee el turno completo, aislado por dueño', async () => {
    const at = new Date(BASE);
    const messages = turn('hola', at);
    const { conversation } = await store.create(ANA, {
      id: uuid(),
      title: 'hola',
      createdAt: at,
      messages,
    });
    const read = await store.get(ANA, conversation.id);
    expect(read?.messages).toEqual(messages);
    expect(await store.get(LUIS, conversation.id)).toBeUndefined();
    expect(await store.append(LUIS, conversation.id, turn('x', at), at)).toBeUndefined();
    expect(await store.rename(LUIS, conversation.id, 'mío')).toBe(false);
    expect(await store.delete(LUIS, conversation.id)).toBe(false);
    expect(await store.get(ANA, 'no-es-uuid')).toBeUndefined();
  });

  it('borra reasoning heredado en la migración y nunca lo devuelve desde filas antiguas', async () => {
    const at = new Date(BASE + 60_000);
    const { conversation } = await store.create(ANA, {
      id: uuid(),
      title: 'legado',
      createdAt: at,
      messages: turn('legado', at),
    });
    const admin = new Client(url);
    await admin.connect();
    try {
      await admin.query(
        `UPDATE assistant_conversations
         SET messages = jsonb_set(messages, '{1,reasoning}', $1::jsonb, true)
         WHERE id = $2`,
        [
          JSON.stringify([
            { kind: 'thought', text: 'PENSAMIENTO PRIVADO' },
            { kind: 'tool', label: 'Buscando alertas', ok: true },
          ]),
          conversation.id,
        ],
      );
      await admin.query(removeThinkingMigration);
      const row = await admin.query<{ messages: Record<string, unknown>[] }>(
        'SELECT messages FROM assistant_conversations WHERE id = $1',
        [conversation.id],
      );
      expect(row.rows[0]?.messages[1]).not.toHaveProperty('reasoning');
    } finally {
      await admin.end();
    }

    const reopened = await store.get(ANA, conversation.id);
    expect(reopened?.messages[1]).not.toHaveProperty('reasoning');
    expect(reopened?.messages[1]?.steps).toEqual([
      { tool: 'list_alerts', label: 'Buscando alertas', ok: true },
    ]);
  });

  it('el compare-and-set no pierde turnos con escrituras concurrentes', async () => {
    const at = new Date(BASE + 60_000);
    const { conversation } = await store.create(ANA, {
      id: uuid(),
      title: 'concurrente',
      createdAt: at,
      messages: turn('inicio', at),
    });
    const results = await Promise.allSettled(
      [1, 2].map((index) =>
        store.append(ANA, conversation.id, turn(`t${index}`, at), new Date(BASE + 120_000)),
      ),
    );
    const ok = results.filter((result) => result.status === 'fulfilled').length;
    expect((await store.get(ANA, conversation.id))?.messages).toHaveLength(2 + ok * 2);
  });

  it('pagina por clave y aplica el tope por persona en la transacción', async () => {
    for (let index = 0; index < CONVERSATION_LIMITS.maxConversationsPerOwner + 2; index += 1) {
      const at = new Date(BASE + 3_600_000 + index * 1000);
      await store.create(LUIS, {
        id: uuid(),
        title: `c${index}`,
        createdAt: at,
        messages: turn('q', at),
      });
    }
    const first = await store.list(LUIS, { limit: 60 });
    const second = await store.list(LUIS, { limit: 60, after: first.next! });
    expect(first.items).toHaveLength(60);
    expect(second.items).toHaveLength(40);
    expect(second.next).toBeNull();
    expect(first.items[0]?.title).toBe(`c${CONVERSATION_LIMITS.maxConversationsPerOwner + 1}`);
    expect(first.items[0]?.messageCount).toBe(2);
  });

  it('renombra, borra y purga de verdad', async () => {
    const at = new Date(BASE - 86_400_000);
    const { conversation } = await store.create(ANA, {
      id: uuid(),
      title: 'vieja',
      createdAt: at,
      messages: turn('vieja', at),
    });
    expect(await store.rename(ANA, conversation.id, 'Renombrada')).toBe(true);
    expect((await store.get(ANA, conversation.id))?.title).toBe('Renombrada');
    expect(await store.purgeOlderThan(ANA.tenantId, new Date(BASE - 1000))).toBe(1);
    expect(await store.get(ANA, conversation.id)).toBeUndefined();
    const deleted = await store.deleteAllByOwner(ANA);
    expect(deleted).toBeGreaterThan(0);
    expect((await store.list(ANA)).items).toEqual([]);
    expect((await store.list(LUIS)).items.length).toBeGreaterThan(0);
  });

  it('los CHECK de la migración rechazan filas fuera de forma', async () => {
    const client = new Client(url);
    await client.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO assistant_conversations (id, tenant_id, owner_id, title, created_at, updated_at, message_count, messages)
           VALUES ($1, 't', 'o', $2, now(), now(), 0, '[]'::jsonb)`,
          [uuid(), 'x'.repeat(81)],
        ),
      ).rejects.toThrow(/assistant_conversations_title_length/u);
      await expect(
        client.query(
          `INSERT INTO assistant_conversations (id, tenant_id, owner_id, title, created_at, updated_at, message_count, messages)
           VALUES ($1, 't', 'o', 't', now(), now(), 1, '[]'::jsonb)`,
          [uuid()],
        ),
      ).rejects.toThrow(/assistant_conversations_messages_array/u);
    } finally {
      await client.end();
    }
  });
});
