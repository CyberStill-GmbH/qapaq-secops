import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_LIMITS,
  ConversationError,
  InMemoryConversationStore,
  clampStoredText,
  conversationTitleFrom,
  normalizeConversationTitle,
  type StoredMessage,
} from '../src/index.js';

const ANA = { tenantId: 't1', ownerId: 'ana' };
const LUIS = { tenantId: 't1', ownerId: 'luis' };
const ANA_OTHER_TENANT = { tenantId: 't2', ownerId: 'ana' };

let sequence = 0;
function id(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 10, 1, 12, minutes));
}

function turn(text: string, when: Date): StoredMessage[] {
  return [
    { id: id(), role: 'user', text, createdAt: when },
    {
      id: id(),
      role: 'assistant',
      text: `respuesta a ${text}`,
      steps: [{ tool: 'list_alerts', label: 'Buscando alertas', ok: true }],
      citations: [{ kind: 'alert', id: 'a1', label: 'Alerta 1' }],
      createdAt: when,
    },
  ];
}

async function seed(store: InMemoryConversationStore, owner = ANA, minute = 0, title = 'hola') {
  const created = await store.create(owner, {
    id: id(),
    title,
    createdAt: at(minute),
    messages: turn(title, at(minute)),
  });
  return created.conversation;
}

describe('historial de Qapaqzito · dominio', () => {
  it('título automático: primera pregunta en una línea, máximo 60 caracteres', () => {
    expect(conversationTitleFrom('¿Qué alertas\nP1 hay\t abiertas?')).toBe(
      '¿Qué alertas P1 hay abiertas?',
    );
    expect(conversationTitleFrom('x'.repeat(100))).toHaveLength(60);
    expect(conversationTitleFrom('   \n ')).toBe('Conversación');
  });

  it('el título elegido se normaliza y se limita a 80 caracteres', () => {
    expect(normalizeConversationTitle('  Incidente\n de phishing ')).toBe('Incidente de phishing');
    for (const invalid of ['', '   ', 'x'.repeat(81), 12, undefined]) {
      expect(() => normalizeConversationTitle(invalid)).toThrow(ConversationError);
    }
  });

  it('recorta la respuesta al máximo almacenable', () => {
    expect(clampStoredText('x'.repeat(30_000))).toHaveLength(CONVERSATION_LIMITS.maxMessageChars);
    expect(clampStoredText('corto')).toBe('corto');
  });
});

describe('historial de Qapaqzito · almacén en memoria', () => {
  it('aísla por (tenant, dueño): lo ajeno es inexistente para leer, continuar, renombrar o borrar', async () => {
    const store = new InMemoryConversationStore();
    const mine = await seed(store);
    for (const stranger of [LUIS, ANA_OTHER_TENANT]) {
      expect(await store.get(stranger, mine.id)).toBeUndefined();
      expect(await store.append(stranger, mine.id, turn('x', at(5)), at(5))).toBeUndefined();
      expect(await store.rename(stranger, mine.id, 'robado')).toBe(false);
      expect(await store.delete(stranger, mine.id)).toBe(false);
      expect((await store.list(stranger)).items).toEqual([]);
      expect(await store.deleteAllByOwner(stranger)).toBe(0);
    }
    expect((await store.get(ANA, mine.id))?.messages).toHaveLength(2);
    expect((await store.get(ANA, mine.id))?.title).toBe('hola');
  });

  it('agrega turnos de forma atómica y mueve la conversación al principio', async () => {
    const store = new InMemoryConversationStore();
    const first = await seed(store, ANA, 0, 'primera');
    await seed(store, ANA, 1, 'segunda');
    const updated = await store.append(ANA, first.id, turn('sigo', at(10)), at(10));
    expect(updated?.messages.map((message) => message.text)).toEqual([
      'primera',
      'respuesta a primera',
      'sigo',
      'respuesta a sigo',
    ]);
    const page = await store.list(ANA);
    expect(page.items.map((item) => item.title)).toEqual(['primera', 'segunda']);
    expect(page.items[0]).toMatchObject({ messageCount: 4, updatedAt: at(10) });
  });

  it('pagina por cursor, más recientes primero, sin duplicar', async () => {
    const store = new InMemoryConversationStore();
    for (let minute = 0; minute < 5; minute += 1) await seed(store, ANA, minute, `c${minute}`);
    const first = await store.list(ANA, { limit: 2 });
    expect(first.items.map((item) => item.title)).toEqual(['c4', 'c3']);
    expect(first.next).not.toBeNull();
    const second = await store.list(ANA, { limit: 2, after: first.next! });
    expect(second.items.map((item) => item.title)).toEqual(['c2', 'c1']);
    const third = await store.list(ANA, { limit: 2, after: second.next! });
    expect(third.items.map((item) => item.title)).toEqual(['c0']);
    expect(third.next).toBeNull();
  });

  it('con 100 conversaciones, crear otra descarta la menos reciente', async () => {
    const store = new InMemoryConversationStore();
    const oldest = await seed(store, ANA, 0, 'la más vieja');
    for (let index = 1; index < CONVERSATION_LIMITS.maxConversationsPerOwner; index += 1) {
      await seed(store, ANA, index, `c${index}`);
    }
    await seed(store, LUIS, 0, 'de Luis');
    const created = await store.create(ANA, {
      id: id(),
      title: 'nueva',
      createdAt: at(500),
      messages: turn('nueva', at(500)),
    });
    expect(created.evicted).toBe(1);
    expect(await store.get(ANA, oldest.id)).toBeUndefined();
    expect((await store.list(ANA, { limit: 100 })).items).toHaveLength(100);
    // El tope es por persona: lo de Luis no se toca.
    expect((await store.list(LUIS)).items).toHaveLength(1);
  });

  it('rechaza superar 200 mensajes y textos de más de 20 000 caracteres', async () => {
    const store = new InMemoryConversationStore();
    const conversation = await seed(store);
    for (let index = 1; index < CONVERSATION_LIMITS.maxMessagesPerConversation / 2; index += 1) {
      await store.append(ANA, conversation.id, turn(`t${index}`, at(index)), at(index));
    }
    expect((await store.get(ANA, conversation.id))?.messages).toHaveLength(200);
    await expect(
      store.append(ANA, conversation.id, turn('una más', at(300)), at(300)),
    ).rejects.toMatchObject({ code: 'MESSAGE_LIMIT' });
    const other = await seed(store, ANA, 400, 'otra');
    await expect(
      store.append(
        ANA,
        other.id,
        [{ id: id(), role: 'user', text: 'x'.repeat(20_001), createdAt: at(401) }],
        at(401),
      ),
    ).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    // Nada a medias: la conversación quedó como estaba.
    expect((await store.get(ANA, other.id))?.messages).toHaveLength(2);
  });

  it('renombra sin cambiar el orden y borra de verdad', async () => {
    const store = new InMemoryConversationStore();
    const first = await seed(store, ANA, 0, 'a');
    const second = await seed(store, ANA, 1, 'b');
    expect(await store.rename(ANA, first.id, 'Phishing de ayer')).toBe(true);
    expect((await store.list(ANA)).items.map((item) => item.title)).toEqual([
      'b',
      'Phishing de ayer',
    ]);
    expect(await store.delete(ANA, second.id)).toBe(true);
    expect(await store.get(ANA, second.id)).toBeUndefined();
    await seed(store, LUIS);
    expect(await store.deleteAllByOwner(ANA)).toBe(1);
    expect((await store.list(ANA)).items).toEqual([]);
    expect((await store.list(LUIS)).items).toHaveLength(1);
  });

  it('purga por retención solo lo inactivo del tenant indicado', async () => {
    const store = new InMemoryConversationStore();
    const old = await seed(store, ANA, 0, 'vieja');
    const recent = await seed(store, LUIS, 30, 'reciente');
    const otherTenant = await seed(store, ANA_OTHER_TENANT, 0, 'otro tenant');
    expect(await store.purgeOlderThan('t1', at(15))).toBe(1);
    expect(await store.get(ANA, old.id)).toBeUndefined();
    expect(await store.get(LUIS, recent.id)).toBeDefined();
    expect(await store.get(ANA_OTHER_TENANT, otherTenant.id)).toBeDefined();
  });
});

describe('historial de Qapaqzito · valoración de respuestas', () => {
  it('guarda y quita 👍/👎 solo en respuestas de Qapaqzito propias, sin reordenar', async () => {
    const store = new InMemoryConversationStore();
    const conversation = await seed(store);
    const [question, answer] = conversation.messages;
    expect(await store.setFeedback(ANA, conversation.id, answer!.id, 'down')).toBe(true);
    let stored = await store.get(ANA, conversation.id);
    expect(stored?.messages[1]?.feedback).toBe('down');
    expect(stored?.updatedAt).toEqual(conversation.updatedAt);
    expect(await store.setFeedback(ANA, conversation.id, answer!.id, null)).toBe(true);
    stored = await store.get(ANA, conversation.id);
    expect(stored?.messages[1]).not.toHaveProperty('feedback');
    // Pregunta de la persona, mensaje inexistente o conversación ajena: no se valora.
    expect(await store.setFeedback(ANA, conversation.id, question!.id, 'up')).toBe(false);
    expect(await store.setFeedback(ANA, conversation.id, id(), 'up')).toBe(false);
    expect(await store.setFeedback(LUIS, conversation.id, answer!.id, 'up')).toBe(false);
  });
});
