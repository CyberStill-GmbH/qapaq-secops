/**
 * Historial de conversaciones de Qapaqzito (dominio, sin frameworks).
 *
 * Reglas que cualquier adaptador debe cumplir:
 * - **Aislamiento absoluto por dueño** (`tenantId` + `ownerId`): todas las operaciones reciben al
 *   dueño y una conversación ajena se comporta como inexistente (ni siquiera un administrador la
 *   ve, la continúa o la borra). No hay operación que lea conversaciones de otra persona.
 * - **Topes**: 100 conversaciones por persona (al crear la 101.ª se descarta la menos reciente),
 *   200 mensajes por conversación (se rechaza el turno), 20 000 caracteres por mensaje.
 * - **Título automático**: primeros 60 caracteres de la primera pregunta, sin saltos de línea.
 * - **Borrado real**: `delete`, `deleteAllByOwner` y la purga por retención eliminan las filas.
 *
 * El contenido se guarda tal como lo vio la persona (sin seudonimizar): es dato del SOC y vive
 * en el mismo almacén cifrado en reposo que el resto. Nunca se escribe en logs ni en auditoría.
 */

import type { ArtifactRef } from './artifacts.js';
import type { Citation } from './ports.js';
import type { AssistantStep } from './run.js';

export const CONVERSATION_LIMITS = Object.freeze({
  maxConversationsPerOwner: 100,
  maxMessagesPerConversation: 200,
  maxMessageChars: 20_000,
  autoTitleChars: 60,
  maxTitleChars: 80,
  /** Pasos y citas curados que se guardan por mensaje. */
  maxEntriesPerMessage: 100,
});

export type MessageTone = 'error' | 'notice';
/** Valoración de la persona sobre una respuesta de Qapaqzito (👍/👎). */
export type MessageFeedback = 'up' | 'down';
export const MESSAGE_FEEDBACK: readonly MessageFeedback[] = ['up', 'down'];

export interface ConversationOwner {
  readonly tenantId: string;
  /** `subjectId` de la sesión. */
  readonly ownerId: string;
}

export interface StoredMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly steps?: readonly AssistantStep[];
  readonly citations?: readonly Citation[];
  /** Archivos generados en este mensaje (informes); pueden haber vencido al releer. */
  readonly artifacts?: readonly ArtifactRef[];
  readonly tone?: MessageTone;
  /** Valoración de la respuesta (solo mensajes de Qapaqzito). */
  readonly feedback?: MessageFeedback;
  readonly createdAt: Date;
}

export interface StoredConversation {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly messages: readonly StoredMessage[];
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly messageCount: number;
}

/** Posición de paginación por clave: la última conversación entregada. */
export interface ConversationCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

export interface ConversationPage {
  readonly items: readonly ConversationSummary[];
  readonly next: ConversationCursor | null;
}

export interface NewConversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: Date;
  readonly messages: readonly StoredMessage[];
}

export interface CreatedConversation {
  readonly conversation: StoredConversation;
  /** Conversaciones antiguas descartadas por el tope por persona. */
  readonly evicted: number;
}

export type ConversationErrorCode =
  'MESSAGE_LIMIT' | 'TEXT_TOO_LONG' | 'INVALID_MESSAGE' | 'INVALID_TITLE' | 'CONFLICT';

export class ConversationError extends Error {
  public constructor(public readonly code: ConversationErrorCode) {
    super(code);
    this.name = 'ConversationError';
  }
}

/** Puerto del historial. Toda operación está acotada al dueño. */
export interface ConversationStore {
  /** Más recientes primero (`updatedAt` desc, `id` desc). Sin mensajes. */
  list(
    owner: ConversationOwner,
    options?: { readonly limit?: number; readonly after?: ConversationCursor },
  ): Promise<ConversationPage>;
  get(owner: ConversationOwner, id: string): Promise<StoredConversation | undefined>;
  /** Crea con su primer turno, en una sola escritura; aplica el tope por persona. */
  create(owner: ConversationOwner, draft: NewConversation): Promise<CreatedConversation>;
  /**
   * Agrega los mensajes de un turno de forma atómica (todos o ninguno). `undefined` si la
   * conversación no existe o es ajena; `MESSAGE_LIMIT` si superaría el tope.
   */
  append(
    owner: ConversationOwner,
    id: string,
    messages: readonly StoredMessage[],
    at: Date,
  ): Promise<StoredConversation | undefined>;
  /** Cambia el título sin alterar el orden. `false` si no existe o es ajena. */
  rename?(owner: ConversationOwner, id: string, title: string): Promise<boolean>;
  /**
   * Guarda (o quita, con `null`) la valoración de una respuesta de Qapaqzito sin alterar el orden.
   * `false` si la conversación o el mensaje no existen, son ajenos o el mensaje no es de Qapaqzito.
   */
  setFeedback?(
    owner: ConversationOwner,
    id: string,
    messageId: string,
    feedback: MessageFeedback | null,
  ): Promise<boolean>;
  delete(owner: ConversationOwner, id: string): Promise<boolean>;
  deleteAllByOwner(owner: ConversationOwner): Promise<number>;
  /** Borra las conversaciones del tenant sin actividad desde `cutoff`. */
  purgeOlderThan(tenantId: string, cutoff: Date): Promise<number>;
}

/** Título automático: la primera pregunta en una línea, recortada a 60 caracteres. */
export function conversationTitleFrom(question: string): string {
  const flat = question.replace(/\s+/gu, ' ').trim();
  const title = Array.from(flat).slice(0, CONVERSATION_LIMITS.autoTitleChars).join('').trim();
  return title === '' ? 'Conversación' : title;
}

/** Título elegido por la persona: una línea, 1–80 caracteres. */
export function normalizeConversationTitle(value: unknown): string {
  if (typeof value !== 'string') throw new ConversationError('INVALID_TITLE');
  const title = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (title.length === 0 || title.length > CONVERSATION_LIMITS.maxTitleChars) {
    throw new ConversationError('INVALID_TITLE');
  }
  return title;
}

/** Recorta un texto al máximo almacenable (para la respuesta del modelo, que puede ser larga). */
export function clampStoredText(text: string): string {
  const max = CONVERSATION_LIMITS.maxMessageChars;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function validMessage(message: StoredMessage): void {
  if (
    (message.role !== 'user' && message.role !== 'assistant') ||
    typeof message.text !== 'string' ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    !(message.createdAt instanceof Date) ||
    Number.isNaN(message.createdAt.getTime())
  ) {
    throw new ConversationError('INVALID_MESSAGE');
  }
  if (message.text.length > CONVERSATION_LIMITS.maxMessageChars) {
    throw new ConversationError('TEXT_TOO_LONG');
  }
  for (const list of [message.steps, message.citations, message.artifacts]) {
    if (list !== undefined && list.length > CONVERSATION_LIMITS.maxEntriesPerMessage) {
      throw new ConversationError('INVALID_MESSAGE');
    }
  }
}

/** Validación común de los adaptadores antes de escribir. */
export function assertStorableMessages(
  messages: readonly StoredMessage[],
  existingCount = 0,
): void {
  if (messages.length === 0) throw new ConversationError('INVALID_MESSAGE');
  if (existingCount + messages.length > CONVERSATION_LIMITS.maxMessagesPerConversation) {
    throw new ConversationError('MESSAGE_LIMIT');
  }
  messages.forEach(validMessage);
}

/** Orden total: `updatedAt` desc y, a igual instante, `id` desc. */
function newestFirst(
  left: { updatedAt: Date; id: string },
  right: { updatedAt: Date; id: string },
): number {
  const delta = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (delta !== 0) return delta;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function summaryOf(conversation: StoredConversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
  };
}

/** Adaptador en memoria (desarrollo y pruebas). Mismas reglas que el durable. */
/** Mensajes con la valoración aplicada, o `undefined` si el mensaje no existe o no es de Qapaqzito. */
export function withFeedback(
  messages: readonly StoredMessage[],
  messageId: string,
  feedback: MessageFeedback | null,
): StoredMessage[] | undefined {
  const index = messages.findIndex((message) => message.id === messageId);
  const target = messages[index];
  if (!target || target.role !== 'assistant') return undefined;
  const { feedback: _previous, ...rest } = target;
  const next = [...messages];
  next[index] = feedback ? { ...rest, feedback } : rest;
  return next;
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly rows = new Map<string, StoredConversation>();

  private owned(owner: ConversationOwner, id: string): StoredConversation | undefined {
    const row = this.rows.get(id);
    return row && row.tenantId === owner.tenantId && row.ownerId === owner.ownerId
      ? row
      : undefined;
  }

  private byOwner(owner: ConversationOwner): StoredConversation[] {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === owner.tenantId && row.ownerId === owner.ownerId)
      .sort(newestFirst);
  }

  public async list(
    owner: ConversationOwner,
    options: { readonly limit?: number; readonly after?: ConversationCursor } = {},
  ): Promise<ConversationPage> {
    const limit = Math.max(
      1,
      Math.min(options.limit ?? 50, CONVERSATION_LIMITS.maxConversationsPerOwner),
    );
    const after = options.after;
    const remaining = this.byOwner(owner).filter(
      (row) => after === undefined || newestFirst(after, row) < 0,
    );
    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(summaryOf),
      next: remaining.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null,
    };
  }

  public async get(owner: ConversationOwner, id: string): Promise<StoredConversation | undefined> {
    return this.owned(owner, id);
  }

  public async create(
    owner: ConversationOwner,
    draft: NewConversation,
  ): Promise<CreatedConversation> {
    assertStorableMessages(draft.messages);
    if (this.rows.has(draft.id)) throw new ConversationError('CONFLICT');
    const mine = this.byOwner(owner);
    let evicted = 0;
    while (mine.length - evicted >= CONVERSATION_LIMITS.maxConversationsPerOwner) {
      const oldest = mine[mine.length - 1 - evicted];
      if (!oldest) break;
      this.rows.delete(oldest.id);
      evicted += 1;
    }
    const lastAt = draft.messages.at(-1)?.createdAt ?? draft.createdAt;
    const conversation: StoredConversation = {
      id: draft.id,
      tenantId: owner.tenantId,
      ownerId: owner.ownerId,
      title: draft.title,
      createdAt: draft.createdAt,
      updatedAt: lastAt > draft.createdAt ? lastAt : draft.createdAt,
      messages: [...draft.messages],
    };
    this.rows.set(conversation.id, conversation);
    return { conversation, evicted };
  }

  public async append(
    owner: ConversationOwner,
    id: string,
    messages: readonly StoredMessage[],
    at: Date,
  ): Promise<StoredConversation | undefined> {
    const row = this.owned(owner, id);
    if (!row) return undefined;
    assertStorableMessages(messages, row.messages.length);
    const updated: StoredConversation = {
      ...row,
      updatedAt: at,
      messages: [...row.messages, ...messages],
    };
    this.rows.set(id, updated);
    return updated;
  }

  public async rename(owner: ConversationOwner, id: string, title: string): Promise<boolean> {
    const row = this.owned(owner, id);
    if (!row) return false;
    this.rows.set(id, { ...row, title: normalizeConversationTitle(title) });
    return true;
  }

  public async setFeedback(
    owner: ConversationOwner,
    id: string,
    messageId: string,
    feedback: MessageFeedback | null,
  ): Promise<boolean> {
    const row = this.owned(owner, id);
    if (!row) return false;
    const next = withFeedback(row.messages, messageId, feedback);
    if (!next) return false;
    this.rows.set(id, { ...row, messages: next });
    return true;
  }

  public async delete(owner: ConversationOwner, id: string): Promise<boolean> {
    if (!this.owned(owner, id)) return false;
    return this.rows.delete(id);
  }

  public async deleteAllByOwner(owner: ConversationOwner): Promise<number> {
    const mine = this.byOwner(owner);
    for (const row of mine) this.rows.delete(row.id);
    return mine.length;
  }

  public async purgeOlderThan(tenantId: string, cutoff: Date): Promise<number> {
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (row.tenantId === tenantId && row.updatedAt < cutoff) {
        this.rows.delete(id);
        purged += 1;
      }
    }
    return purged;
  }

  public async close(): Promise<void> {}
}
