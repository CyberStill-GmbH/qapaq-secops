/**
 * Qapaqzito, el asistente de IA de QAPAQ SOC: `POST /api/assistant/chat` y el historial de
 * conversaciones (`/api/assistant/conversations`).
 *
 * Reglas:
 * - Exige sesión; las mutaciones (chat, renombrar, borrar) exigen además el token CSRF.
 * - Solo ofrece herramientas que la persona podría usar y las ejecuta **con su propia sesión**
 *   (`internal-client.ts`): la autorización y las redacciones son las de la API, no las de Qapaqzito.
 * - Sin `QAPAQ_QAPAQZITO_ENABLED=true` responde 404 (`RESOURCE_UNAVAILABLE`).
 * - Historial (`QAPAQ_QAPAQZITO_HISTORY_ENABLED`, defecto `true`): cada conversación pertenece a
 *   (tenant, `subjectId`) y solo su dueño la lista, lee, continúa, renombra o borra; ni un
 *   administrador ve las ajenas. Un id ajeno o vencido responde igual que uno inexistente.
 *   Apagado, el chat no guarda y los endpoints del historial responden 404.
 * - Con historial activo el servidor usa el historial **guardado** (o ninguno, si la conversación
 *   es nueva) e ignora el `history` del cliente, que solo se usa con el historial apagado
 *   (compatibilidad). El turno se guarda después de obtener
 *   la respuesta, en una sola escritura; si falla, la respuesta sale igual con `saved: false`.
 * - Auditoría: `assistant.ask` por pregunta (herramientas usadas), `assistant.conversation.delete`
 *   y `assistant.conversation.purge` con conteos. El texto nunca va a auditoría ni a logs.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { planAuditQuery, recordAudit } from '@qapaq/audit';

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  AssistantCancelledError,
  AssistantInputError,
  CONVERSATION_LIMITS,
  DEFAULT_ASSISTANT_LIMITS,
  Pseudonymizer,
  type ArtifactRef,
  artifactRefOf,
  clampStoredText,
  conversationTitleFrom,
  MESSAGE_FEEDBACK,
  normalizeConversationTitle,
  type MessageFeedback,
  runAssistant,
  type AssistantProgressEvent,
  type AssistantResult,
  type ConversationOwner,
  type StoredConversation,
  type StoredMessage,
} from '@qapaq/assistant';

import { ApiError } from '../http/api-error.js';
import type { IncomingRequest, OutgoingReply } from '../http/http-contracts.js';
import { paginate, type PageQuery } from '../http/pagination.js';
import { mutatingActor, readingActor } from '../soc/session-actor.js';
import { SECOPS_RUNTIME } from '../soc/tokens.js';
import type { SecOpsRuntime } from '../runtime/secops-runtime.js';
import type { AssistantService } from './assistant-service.js';
import { auditConversationRemoval, type ConversationHistory } from './conversation-history.js';
import { createInternalGet } from './internal-client.js';
import { buildReportTool, type StoredReport } from './report-tool.js';
import { buildSocTools } from './soc-tools.js';
import { connectMcpInProcess } from './mcp-protocol.js';
import { startInvestigationAction } from './analyst-tools.js';

/** Capacidades de lectura: haber una basta para usar a Qapaqzito (las herramientas filtran el resto). */
const READ_CAPABILITIES = [
  'alerts.read',
  'incidents.read',
  'events.read',
  'sources.health.read',
  'notifications.read',
  'audit.read',
  'observability.read_soc',
  'users.read',
] as const;

/**
 * Presupuesto de reloj del turno. En Lambda, API Gateway corta a los 30 s; en el nodo EC2 el
 * proxy de borde admite 65 s para `/api/assistant`, así que Qapaqzito puede investigar más a fondo.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface ChatBody {
  message?: unknown;
  history?: unknown;
  page?: unknown;
  conversationId?: unknown;
}

interface Actor {
  readonly subjectId: string;
  readonly tenantId: string;
  readonly capabilities: ReadonlySet<string>;
}

class AssistantEventQueue implements AsyncIterable<Buffer> {
  private readonly items: Buffer[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  public push(event: string, data: unknown): void {
    if (this.ended) return;
    this.items.push(Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    this.wake?.();
    this.wake = undefined;
  }

  public close(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }

  public cancel(): void {
    this.items.length = 0;
    this.close();
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** Ata la cancelación al cierre abrupto; un cierre HTTP completado no cancela el turno. */
export function observeStreamDisconnect(
  raw: NonNullable<OutgoingReply['raw']> | undefined,
  abort: () => void,
): () => void {
  if (!raw) return () => undefined;
  const onClose = () => {
    if (raw.writableFinished !== true) abort();
  };
  raw.on('close', onClose);
  return () => raw.off('close', onClose);
}

function parseHistory(
  value: unknown,
): { role: 'user' | 'assistant'; content: string }[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 60) return undefined;
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const entry of value as unknown[]) {
    const item = entry as { role?: unknown; content?: unknown };
    if ((item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') {
      return undefined;
    }
    history.push({ role: item.role, content: item.content });
  }
  return history;
}

function canUseQapaqzito(service: AssistantService | undefined, actor: Actor): boolean {
  return (
    service !== undefined &&
    READ_CAPABILITIES.some((capability) => actor.capabilities.has(capability))
  );
}

function ownerOf(actor: Actor): ConversationOwner {
  return { tenantId: actor.tenantId, ownerId: actor.subjectId };
}

/** Mensaje tal como lo recibe la interfaz. */
function messageView(message: StoredMessage) {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    ...(message.steps ? { steps: message.steps } : {}),
    ...(message.citations ? { citations: message.citations } : {}),
    ...(message.artifacts && message.artifacts.length > 0 ? { artifacts: message.artifacts } : {}),
    ...(message.tone ? { tone: message.tone } : {}),
    ...(message.feedback ? { feedback: message.feedback } : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

/** Respuesta del modelo lista para guardar: textos recortados al máximo almacenable. */
function assistantMessage(
  result: AssistantResult,
  at: Date,
  artifacts: readonly ArtifactRef[] = [],
): StoredMessage {
  const max = CONVERSATION_LIMITS.maxEntriesPerMessage;
  return {
    id: randomUUID(),
    role: 'assistant',
    text: clampStoredText(result.reply),
    steps: result.steps.slice(0, max),
    citations: result.citations.slice(0, max),
    ...(artifacts.length > 0 ? { artifacts: artifacts.slice(0, max) } : {}),
    ...(result.outcome === 'refused' || result.outcome === 'unverified'
      ? { tone: 'notice' as const }
      : {}),
    createdAt: at,
  };
}

@Controller('api/assistant')
export class AssistantController {
  public constructor(@Inject(SECOPS_RUNTIME) private readonly runtime: SecOpsRuntime) {}

  /** La consola pregunta si Qapaqzito está disponible para mostrar o no el botón. */
  @Get('config')
  public async config(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const service = this.runtime.assistant;
    const available = canUseQapaqzito(service, actor);
    return {
      correlationId,
      enabled: available,
      name: 'Qapaqzito',
      ...(available && service
        ? {
            readOnly: true,
            redactsPersonalData: service.config.redactPii,
            provider: service.config.provider,
            model: service.config.model,
            effort: service.config.effort,
            rateLimit: service.config.rateLimit.max,
            history: service.history !== undefined,
            ...(service.history ? { retentionDays: service.history.retentionDays } : {}),
          }
        : {}),
    };
  }

  /** Métricas agregadas de uso para plataforma; no devuelve prompts, respuestas ni actor. */
  @Get('usage')
  public async usage(
    @Req() request: IncomingRequest,
    @Query() query: { from?: string; to?: string; cursor?: string },
  ) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    if (!actor.capabilities.has('observability.read_platform')) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    const now = this.runtime.now();
    const to = query.to ? new Date(query.to) : now;
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from.getTime() > to.getTime() ||
      to.getTime() > now.getTime() + 60_000 ||
      to.getTime() - from.getTime() > 30 * 24 * 60 * 60 * 1000 ||
      (query.cursor !== undefined && query.cursor.length > 1024)
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['range']);
    }
    const plan = planAuditQuery(
      {
        from: from.toISOString(),
        to: to.toISOString(),
        pageSize: 200,
        action: 'assistant.ask',
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
      { tenantId: actor.tenantId, capabilities: actor.capabilities },
    );
    if (!plan.ok) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    let page: Awaited<ReturnType<SecOpsRuntime['audit']['read']>>;
    try {
      page = await this.runtime.audit.read(plan.query);
    } catch {
      throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    }
    const totals = {
      requests: page.events.length,
      succeeded: 0,
      failed: 0,
      measured: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const byModel = new Map<
      string,
      {
        provider: string;
        model: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }
    >();
    for (const event of page.events) {
      if (event.outcome === 'succeeded') totals.succeeded += 1;
      else if (event.outcome === 'failed') totals.failed += 1;
      const metadata = event.metadata ?? {};
      const provider = typeof metadata['provider'] === 'string' ? metadata['provider'] : 'sin dato';
      const model = typeof metadata['model'] === 'string' ? metadata['model'] : 'sin dato';
      const modelKey = `${provider}:${model}`;
      const modelTotals = byModel.get(modelKey) ?? {
        provider,
        model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      modelTotals.requests += 1;
      byModel.set(modelKey, modelTotals);
      const usage = metadata['usage'];
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
      const values = usage as Record<string, unknown>;
      const numeric = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(
        (key) => values[key],
      );
      if (!numeric.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
      totals.measured += 1;
      totals.inputTokens += values['inputTokens'] as number;
      totals.outputTokens += values['outputTokens'] as number;
      totals.cacheReadTokens += values['cacheReadTokens'] as number;
      totals.cacheWriteTokens += values['cacheWriteTokens'] as number;
      modelTotals.inputTokens += values['inputTokens'] as number;
      modelTotals.outputTokens += values['outputTokens'] as number;
      modelTotals.cacheReadTokens += values['cacheReadTokens'] as number;
      modelTotals.cacheWriteTokens += values['cacheWriteTokens'] as number;
    }
    return {
      correlationId,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)),
      },
      totals,
      models: [...byModel.values()].sort((left, right) => right.requests - left.requests),
      nextCursor: page.nextCursor,
      billing: 'not_connected',
    };
  }

  @Post('chat')
  @HttpCode(200)
  public async chat(@Req() request: IncomingRequest, @Body() body: ChatBody | undefined) {
    const context = await mutatingActor(this.runtime, request);
    return this.executeChat(request, body, context);
  }

  /**
   * SSE solo en el runtime EC2 directo. Emite progreso operativo real y el resultado cuando
   * ya pasó scrub, validación de citas, auditoría y guardado; nunca transmite reasoning ni datos
   * crudos. El endpoint JSON de arriba permanece como fallback para clientes con proxy bufferizado.
   */
  @Post('chat/stream')
  @HttpCode(200)
  public async streamChat(
    @Req() request: IncomingRequest,
    @Body() body: ChatBody | undefined,
    @Res() reply: OutgoingReply,
  ) {
    const queue = new AssistantEventQueue();
    const cancellation = new AbortController();
    const stream = Readable.from(queue);
    const removeDisconnectObserver = observeStreamDisconnect(reply.raw, () => {
      cancellation.abort();
      queue.cancel();
      stream.destroy();
    });
    let context: Awaited<ReturnType<typeof mutatingActor>>;
    try {
      context = await mutatingActor(this.runtime, request);
    } catch (error) {
      removeDisconnectObserver();
      throw error;
    }
    if (cancellation.signal.aborted) {
      removeDisconnectObserver();
      return;
    }
    queue.push('started', { correlationId: context.correlationId });
    reply
      .status(200)
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .send(stream);
    void this.executeChat(
      request,
      body,
      context,
      (event) => queue.push('progress', event),
      cancellation.signal,
      (artifact) => queue.push('artifact', artifact),
    )
      .then((result) => {
        queue.push('complete', result);
      })
      .catch((error: unknown) => {
        if (error instanceof AssistantCancelledError || cancellation.signal.aborted) return;
        if (error instanceof ApiError) {
          queue.push('error', error.getResponse());
          return;
        }
        queue.push('error', { code: 'DEPENDENCY_DEGRADED', correlationId: context.correlationId });
      })
      .finally(() => {
        removeDisconnectObserver();
        queue.close();
      });
  }

  private async executeChat(
    request: IncomingRequest,
    body: ChatBody | undefined,
    context: Awaited<ReturnType<typeof mutatingActor>>,
    onProgress?: (event: AssistantProgressEvent) => void,
    signal?: AbortSignal,
    onArtifact?: (artifact: ArtifactRef) => void,
  ) {
    const { actor, session, correlationId } = context;
    const service = this.runtime.assistant;
    if (!service || !canUseQapaqzito(service, actor)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    if (signal?.aborted) {
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      await this.runtime.auditAssistant(actor.subjectId, context.correlationId, 'failed', [], {
        provider: service.config.provider,
        model: service.config.model,
        usage,
      });
      throw new AssistantCancelledError(usage);
    }
    const message = typeof body?.message === 'string' ? body.message : undefined;
    const clientHistory = parseHistory(body?.history);
    const page = typeof body?.page === 'string' ? body.page.slice(0, 200) : undefined;
    const rawConversationId = body?.conversationId;
    if (message === undefined) throw new ApiError('VALIDATION_FAILED', correlationId, ['message']);
    if (clientHistory === undefined) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['history']);
    }
    if (
      rawConversationId !== undefined &&
      rawConversationId !== null &&
      (typeof rawConversationId !== 'string' || !UUID.test(rawConversationId))
    ) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['conversationId']);
    }
    const conversationId = typeof rawConversationId === 'string' ? rawConversationId : undefined;
    if (!service.limiter.take(actor.subjectId, this.runtime.now().getTime())) {
      throw new ApiError('RATE_LIMITED', correlationId);
    }

    const history = service.history;
    const owner = ownerOf(actor);
    let stored: StoredConversation | undefined;
    if (conversationId !== undefined) {
      // Sin historial no hay conversaciones que continuar.
      if (!history) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
      stored = await this.ownedConversation(history, owner, conversationId, correlationId);
      if (stored.messages.length + 2 > CONVERSATION_LIMITS.maxMessagesPerConversation) {
        // Conversación llena: la interfaz debe ofrecer empezar una nueva.
        throw new ApiError('VALIDATION_FAILED', correlationId, ['messageLimit']);
      }
    }

    const server = this.runtime.internalServer;
    if (!server) throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    const capabilities = [...actor.capabilities].sort();
    const startInvestigation = startInvestigationAction(this.runtime, actor, correlationId, 'qapaqzito');
    const handlers = buildSocTools(
      createInternalGet(server, request, signal),
      { roles: actor.roles, capabilities },
      startInvestigation ? { startInvestigation } : {},
    );
    const connected = await connectMcpInProcess(handlers);
    // Informes: la herramienta escribe un archivo propio de la persona (no es una lectura MCP), así
    // que se añade aquí y no en `buildSocTools`. Disponible con alguna capacidad de lectura de
    // alertas o incidentes; sin servicio de informes responde `unavailable`.
    const generated: ArtifactRef[] = [];
    const vault = service.artifacts;
    const reportTools =
      vault && (actor.capabilities.has('alerts.read') || actor.capabilities.has('incidents.read'))
        ? [
            buildReportTool({
              get: createInternalGet(server, request, signal),
              capabilities: actor.capabilities,
              displayName: session.displayName ?? actor.subjectId,
              consoleBaseUrl: this.runtime.consoleBaseUrl,
              now: () => this.runtime.now(),
              reports: service.reports,
              vault,
              owner: ownerOf(actor),
              conversationId: stored?.id,
              signal,
              onStored: async (report) => {
                generated.push(report.artifact);
                onArtifact?.(report.artifact);
                await this.auditArtifact('assistant.artifact.create', actor, correlationId, report);
              },
            }),
          ]
        : [];
    const tools = [...connected, ...reportTools];
    // Con historial activo manda el servidor: el del cliente se ignora (una conversación nueva
    // empieza vacía) para que lo guardado sea exactamente lo que vio el modelo. Sin historial,
    // el del cliente sigue sirviendo por compatibilidad.
    const turnHistory = stored
      ? stored.messages
          .filter((entry) => entry.tone === undefined)
          .map((entry) => ({ role: entry.role, content: entry.text }))
      : history
        ? []
        : clientHistory;
    const askedAt = this.runtime.now();
    let result: AssistantResult;
    try {
      result = await runAssistant({
        model: service.model,
        tools,
        turn: {
          message,
          history: turnHistory,
          context: {
            displayName: session.displayName,
            roles: actor.roles,
            capabilities,
            ...(page ? { page } : {}),
          },
        },
        pseudonymizer: new Pseudonymizer(service.config.redactPii),
        limits: this.runtime.assistant?.limits ?? DEFAULT_ASSISTANT_LIMITS,
        now: () => this.runtime.now(),
        ...(onProgress ? { onProgress } : {}),
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) throw new AssistantCancelledError(result.usage);
      await this.runtime.auditAssistant(
        actor.subjectId,
        correlationId,
        'succeeded',
        [...new Set(result.steps.map((step) => step.tool))],
        { provider: service.config.provider, model: service.config.model, usage: result.usage },
      );
    } catch (error) {
      if (error instanceof AssistantCancelledError) {
        await this.runtime.auditAssistant(actor.subjectId, correlationId, 'failed', [], {
          provider: service.config.provider,
          model: service.config.model,
          usage: error.usage,
        });
        throw error;
      }
      if (error instanceof AssistantInputError) {
        throw new ApiError('VALIDATION_FAILED', correlationId, ['message']);
      }
      await this.runtime.auditAssistant(actor.subjectId, correlationId, 'failed', []);
      // Sin detalles del proveedor: el motivo interno no sale de la API.
      throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    }

    const saved = history
      ? await this.saveTurn(
          history,
          owner,
          stored,
          message,
          askedAt,
          result,
          correlationId,
          generated,
        )
      : undefined;
    return {
      correlationId,
      reply: result.reply,
      outcome: result.outcome,
      steps: result.steps,
      citations: result.citations,
      ...(generated.length > 0 ? { artifacts: generated } : {}),
      usage: result.usage,
      conversationId: saved?.id ?? null,
      title: saved?.title ?? null,
      saved: saved?.saved ?? false,
      // Id del mensaje guardado de Qapaqzito: la consola lo usa para la valoración 👍/👎.
      messageId: saved?.saved ? saved.messageId : null,
    };
  }

  /** Archivos (informes) vigentes de la persona, más recientes primero. */
  @Get('artifacts')
  public async listArtifacts(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const vault = this.artifactsFor(actor, correlationId);
    const items = await this.guarded(correlationId, () => vault.list(ownerOf(actor)));
    return { correlationId, items: items.map(artifactRefOf) };
  }

  /**
   * Descarga de un archivo: solo su dueño; ajeno, vencido o inexistente responde 404 neutro.
   * La auditoría registra id, formato, tamaño y hash, nunca el contenido.
   */
  @Get('artifacts/:id')
  public async downloadArtifact(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Res() reply: OutgoingReply,
  ) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const vault = this.artifactsFor(actor, correlationId);
    const artifact = UUID.test(id)
      ? await this.guarded(correlationId, () => vault.get(ownerOf(actor), id))
      : undefined;
    if (!artifact) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: this.runtime.now(),
      actor: { id: actor.subjectId, type: 'user' },
      action: 'assistant.artifact.download',
      resource: { type: 'assistant_artifact', id: artifact.id },
      outcome: 'succeeded',
      correlationId,
      metadata: { format: artifact.format, size: artifact.size, sha256: artifact.sha256 },
    }).catch(() => undefined);
    const ascii = artifact.filename.replace(/[^A-Za-z0-9._-]/gu, '_');
    reply
      .status(200)
      .header('content-type', artifact.contentType)
      .header(
        'content-disposition',
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      )
      .header('content-length', String(artifact.size))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(Buffer.from(artifact.content));
  }

  @Get('conversations')
  public async listConversations(@Req() request: IncomingRequest, @Query() query: PageQuery) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const history = this.historyFor(actor, correlationId);
    await history.purgeExpired(
      this.runtime.audit,
      actor.tenantId,
      this.runtime.now(),
      correlationId,
    );
    const all = await this.guarded(correlationId, () =>
      history.store.list(ownerOf(actor), {
        limit: CONVERSATION_LIMITS.maxConversationsPerOwner,
      }),
    );
    const cutoff = history.cutoff(this.runtime.now());
    const page = paginate(
      all.items.filter((item) => item.updatedAt >= cutoff),
      (item) => ({ at: item.updatedAt.getTime(), id: item.id }),
      query,
      'assistant-conversations',
      correlationId,
    );
    return {
      correlationId,
      items: page.items.map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt.toISOString(),
        messageCount: item.messageCount,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Get('conversations/:id')
  public async getConversation(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await readingActor(this.runtime, request);
    const history = this.historyFor(actor, correlationId);
    const conversation = await this.ownedConversation(history, ownerOf(actor), id, correlationId);
    return {
      correlationId,
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: conversation.messages.map(messageView),
    };
  }

  @Patch('conversations/:id')
  public async renameConversation(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Body() body: { title?: unknown } | undefined,
  ) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    const history = this.historyFor(actor, correlationId);
    let title: string;
    try {
      title = normalizeConversationTitle(body?.title);
    } catch {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['title']);
    }
    const owner = ownerOf(actor);
    // Una conversación vencida no se renombra: se comporta como inexistente.
    await this.ownedConversation(history, owner, id, correlationId);
    const store = history.store;
    const renamed = store.rename
      ? await this.guarded(correlationId, () => store.rename!(owner, id, title))
      : false;
    if (!renamed) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    return { correlationId, id, title };
  }

  /**
   * Valoración 👍/👎 de una respuesta de Qapaqzito, guardada con la conversación (`rating: null` la
   * quita). Auditoría `assistant.feedback` con la valoración y los ids, nunca el texto.
   */
  @Put('conversations/:id/messages/:messageId/feedback')
  public async setFeedback(
    @Req() request: IncomingRequest,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: { rating?: unknown } | undefined,
  ) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    const history = this.historyFor(actor, correlationId);
    const rating = body?.rating;
    if (rating !== null && !MESSAGE_FEEDBACK.includes(rating as MessageFeedback)) {
      throw new ApiError('VALIDATION_FAILED', correlationId, ['rating']);
    }
    if (!UUID.test(messageId)) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    const owner = ownerOf(actor);
    await this.ownedConversation(history, owner, id, correlationId);
    const store = history.store;
    const stored = store.setFeedback
      ? await this.guarded(correlationId, () =>
          store.setFeedback!(owner, id, messageId, rating as MessageFeedback | null),
        )
      : false;
    if (!stored) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: this.runtime.now(),
      actor: { id: actor.subjectId, type: 'user' },
      action: 'assistant.feedback',
      resource: { type: 'assistant_conversation', id },
      outcome: 'succeeded',
      correlationId,
      metadata: { messageId, rating: typeof rating === 'string' ? rating : 'none' },
    }).catch(() => undefined);
    return { correlationId, id, messageId, rating: rating ?? null };
  }

  @Delete('conversations/:id')
  @HttpCode(200)
  public async deleteConversation(@Req() request: IncomingRequest, @Param('id') id: string) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    const history = this.historyFor(actor, correlationId);
    const deleted = UUID.test(id)
      ? await this.guarded(correlationId, () => history.store.delete(ownerOf(actor), id))
      : false;
    if (!deleted) throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    await auditConversationRemoval(this.runtime.audit, {
      tenantId: actor.tenantId,
      actor: { id: actor.subjectId, type: 'user' },
      action: 'assistant.conversation.delete',
      resourceId: id,
      count: 1,
      correlationId,
      at: this.runtime.now(),
    });
    return { correlationId, deleted: 1 };
  }

  /** Borra todo mi historial (y solo el mío). */
  @Delete('conversations')
  @HttpCode(200)
  public async deleteAllConversations(@Req() request: IncomingRequest) {
    const { actor, correlationId } = await mutatingActor(this.runtime, request);
    const history = this.historyFor(actor, correlationId);
    const deleted = await this.guarded(correlationId, () =>
      history.store.deleteAllByOwner(ownerOf(actor)),
    );
    if (deleted > 0) {
      await auditConversationRemoval(this.runtime.audit, {
        tenantId: actor.tenantId,
        actor: { id: actor.subjectId, type: 'user' },
        action: 'assistant.conversation.delete',
        resourceId: 'all',
        count: deleted,
        correlationId,
        at: this.runtime.now(),
      });
    }
    return { correlationId, deleted };
  }

  /** Almacén de archivos si Qapaqzito está disponible para esta persona; si no, 404. */
  private artifactsFor(actor: Actor, correlationId: string) {
    const service = this.runtime.assistant;
    if (!service?.artifacts || !canUseQapaqzito(service, actor)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    return service.artifacts;
  }

  private async auditArtifact(
    action: 'assistant.artifact.create',
    actor: Actor,
    correlationId: string,
    report: StoredReport,
  ): Promise<void> {
    await recordAudit(this.runtime.audit, {
      id: randomUUID(),
      tenantId: actor.tenantId,
      occurredAt: this.runtime.now(),
      actor: { id: actor.subjectId, type: 'user' },
      action,
      resource: { type: 'assistant_artifact', id: report.artifact.id },
      outcome: 'succeeded',
      correlationId,
      metadata: {
        kind: report.kind,
        format: report.format,
        size: report.size,
        sha256: report.sha256,
        rows: report.rows,
        ...(report.pages ? { pages: report.pages } : {}),
      },
    }).catch(() => undefined);
  }

  /** Historial disponible para esta persona, o 404 (Qapaqzito o historial apagados, sin permisos). */
  private historyFor(actor: Actor, correlationId: string): ConversationHistory {
    const service = this.runtime.assistant;
    if (!service?.history || !canUseQapaqzito(service, actor)) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    return service.history;
  }

  /** La conversación si es mía y no venció; si no, la misma respuesta que una inexistente. */
  private async ownedConversation(
    history: ConversationHistory,
    owner: ConversationOwner,
    id: string,
    correlationId: string,
  ): Promise<StoredConversation> {
    const conversation = UUID.test(id)
      ? await this.guarded(correlationId, () => history.store.get(owner, id))
      : undefined;
    if (!conversation || conversation.updatedAt < history.cutoff(this.runtime.now())) {
      throw new ApiError('RESOURCE_UNAVAILABLE', correlationId);
    }
    return conversation;
  }

  /** Un fallo del almacén sale como dependencia degradada, sin detalles internos. */
  private async guarded<T>(correlationId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new ApiError('DEPENDENCY_DEGRADED', correlationId);
    }
  }

  /**
   * Guarda el turno (pregunta + respuesta) en una sola escritura. Nunca falla hacia el chat:
   * si el almacén no responde, `saved: false` y la respuesta sale igual.
   */
  private async saveTurn(
    history: ConversationHistory,
    owner: ConversationOwner,
    stored: StoredConversation | undefined,
    question: string,
    askedAt: Date,
    result: AssistantResult,
    correlationId: string,
    artifacts: readonly ArtifactRef[] = [],
  ): Promise<{ id: string | null; title: string | null; saved: boolean; messageId: string }> {
    const answeredAt = this.runtime.now();
    const reply = assistantMessage(result, answeredAt, artifacts);
    const turn: StoredMessage[] = [
      { id: randomUUID(), role: 'user', text: question.trim(), createdAt: askedAt },
      reply,
    ];

    let outcome: { id: string | null; title: string | null; saved: boolean };
    let evicted = 0;
    try {
      if (stored) {
        const updated = await history.store.append(owner, stored.id, turn, answeredAt);
        outcome = { id: stored.id, title: stored.title, saved: updated !== undefined };
      } else {
        const created = await history.store.create(owner, {
          id: randomUUID(),
          title: conversationTitleFrom(question),
          createdAt: askedAt,
          messages: turn,
        });
        outcome = { id: created.conversation.id, title: created.conversation.title, saved: true };
        evicted = created.evicted;
      }
    } catch {
      // Topes del dominio o almacén caído: la respuesta ya existe y se entrega sin guardar.
      outcome = stored
        ? { id: stored.id, title: stored.title, saved: false }
        : { id: null, title: null, saved: false };
    }
    if (evicted > 0) {
      // Tope de conversaciones por persona: se descartaron las menos recientes.
      await auditConversationRemoval(this.runtime.audit, {
        tenantId: owner.tenantId,
        actor: { id: owner.ownerId, type: 'user' },
        action: 'assistant.conversation.purge',
        resourceId: 'limit',
        count: evicted,
        reason: `limit:${CONVERSATION_LIMITS.maxConversationsPerOwner}`,
        correlationId,
        at: answeredAt,
      }).catch(() => undefined);
    }
    await history.purgeExpired(this.runtime.audit, owner.tenantId, answeredAt, correlationId);
    return { ...outcome, messageId: reply.id };
  }
}
