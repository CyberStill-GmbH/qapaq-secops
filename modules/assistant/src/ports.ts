/**
 * Puertos del asistente. El dominio no conoce ningún proveedor de modelos: el adaptador traduce
 * estos tipos a la API de Claude (Anthropic o Bedrock).
 */

export type ToolInput = Readonly<Record<string, unknown>>;

export interface Citation {
  readonly kind: 'alert' | 'incident' | 'event' | 'source' | 'audit';
  readonly id: string;
  readonly label: string;
}

export type ToolOutcome =
  | { readonly ok: true; readonly data: unknown; readonly citations?: readonly Citation[] }
  | { readonly ok: false; readonly error: string };

export interface AssistantTool {
  readonly name: string;
  /** Qué hace y cuándo usarla; el modelo decide con esto. */
  readonly description: string;
  /** JSON Schema del objeto de entrada (`additionalProperties: false`). */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Etiqueta corta para mostrar a la persona («Buscando alertas»). */
  readonly label: string;
  /** Etiqueta según la entrada («Generando informe PDF»); por defecto `label`. */
  labelFor?(input: ToolInput): string;
  /**
   * `false`: la herramienta tiene un efecto (p. ej. encolar una investigación). Sin el campo se
   * considera de solo lectura; el servidor MCP lo publica como `readOnlyHint`.
   */
  readonly readOnly?: boolean;
  run(input: ToolInput, signal?: AbortSignal): Promise<ToolOutcome>;
}

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}
export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: ToolInput;
}
export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}
/** Bloque interno firmado del proveedor; solo se conserva transitoriamente durante una ronda con herramientas. */
export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature: string;
}
/** Razonamiento cifrado por seguridad: opaco, solo se reenvía. */
export interface RedactedThinkingBlock {
  readonly type: 'redacted_thinking';
  readonly data: string;
}
export type ModelBlock = TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock;
export type ConversationBlock = ModelBlock | ToolResultBlock;

export interface ConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly ConversationBlock[];
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly system: string;
  readonly messages: readonly ConversationMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly maxTokens: number;
  /** `false` fuerza una respuesta final sin llamar herramientas (presupuesto agotado). */
  readonly allowTools: boolean;
}

export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens leídos de la caché de prompt (más baratos y rápidos). */
  readonly cacheReadTokens?: number;
  /** Tokens escritos en la caché de prompt. */
  readonly cacheWriteTokens?: number;
}

export interface ModelResponse {
  readonly content: readonly ModelBlock[];
  readonly stopReason: ModelStopReason;
  readonly usage: ModelUsage;
}

/** Puerto del modelo de lenguaje. */
export interface AssistantModel {
  complete(
    request: ModelRequest,
    signal?: AbortSignal,
    onTextDelta?: (text: string) => void,
  ): Promise<ModelResponse>;
}
