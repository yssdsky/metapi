export type DownstreamFormat = 'openai' | 'claude';

export type ParsedSseEvent = {
  event: string;
  data: string;
};

export type StreamTransformContext = {
  id: string;
  model: string;
  created: number;
  roleSent: boolean;
  doneSent: boolean;
};

export type ClaudeDownstreamContext = {
  messageStarted: boolean;
  contentBlockStarted: boolean;
  doneSent: boolean;
};

export type NormalizedStreamEvent = {
  role?: 'assistant';
  contentDelta?: string;
  reasoningDelta?: string;
  finishReason?: string | null;
  done?: boolean;
};

export type NormalizedFinalResponse = {
  id: string;
  model: string;
  created: number;
  content: string;
  reasoningContent: string;
  finishReason: string;
};

export type ParsedDownstreamChatRequest = {
  requestedModel: string;
  isStream: boolean;
  upstreamBody: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pickFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ensureIntegerTimestamp(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function joinNonEmpty(parts: string[]): string {
  return parts.map((item) => item.trim()).filter((item) => item.length > 0).join('\n\n');
}

function textFromPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!isRecord(part)) return '';

  if (typeof part.text === 'string') return part.text;
  if (typeof part.content === 'string') return part.content;
  if (typeof part.output_text === 'string') return part.output_text;
  if (typeof part.completion === 'string') return part.completion;
  if (typeof part.partial_json === 'string') return part.partial_json;
  if (typeof part.reasoning_content === 'string') return part.reasoning_content;
  if (typeof part.reasoning === 'string') return part.reasoning;

  if (Array.isArray(part.content)) {
    return part.content.map((item) => textFromPart(item)).join('');
  }

  if (isRecord(part.delta)) {
    const fromDelta = textFromPart(part.delta);
    if (fromDelta) return fromDelta;
  }

  return '';
}

function extractTextAndReasoning(value: unknown): { content: string; reasoning: string } {
  if (typeof value === 'string') return { content: value, reasoning: '' };
  if (Array.isArray(value)) {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        contentParts.push(item);
        continue;
      }
      if (!isRecord(item)) continue;
      const type = typeof item.type === 'string' ? item.type : '';

      if (type === 'thinking' && typeof item.thinking === 'string') {
        reasoningParts.push(item.thinking);
        continue;
      }
      if (type === 'thinking_delta' && typeof item.text === 'string') {
        reasoningParts.push(item.text);
        continue;
      }
      if (typeof item.thought === 'boolean' && item.thought && typeof item.text === 'string') {
        reasoningParts.push(item.text);
        continue;
      }

      const text = textFromPart(item);
      if (text) contentParts.push(text);
    }

    return {
      content: contentParts.join(''),
      reasoning: reasoningParts.join(''),
    };
  }

  if (!isRecord(value)) return { content: '', reasoning: '' };

  if (Array.isArray(value.parts)) {
    return extractTextAndReasoning(value.parts);
  }

  return {
    content: textFromPart(value),
    reasoning: '',
  };
}

export function normalizeStopReason(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return null;

  if (
    value === 'end_turn'
    || value === 'stop'
    || value === 'end'
    || value === 'eos'
    || value === 'finished'
    || value === 'stop_sequence'
  ) {
    return 'stop';
  }

  if (
    value === 'max_tokens'
    || value === 'length'
    || value === 'max_output_tokens'
    || value === 'max_tokens_exceeded'
    || value.includes('max')
  ) {
    return 'length';
  }

  if (value === 'tool_use' || value === 'tool_calls' || value.includes('tool')) {
    return 'tool_calls';
  }

  return 'stop';
}

export function toClaudeStopReason(finishReason: string | null | undefined): string {
  const value = normalizeStopReason(finishReason);
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

export function createStreamTransformContext(modelName: string): StreamTransformContext {
  return {
    id: `chatcmpl-meta-${Date.now()}`,
    model: modelName,
    created: Math.floor(Date.now() / 1000),
    roleSent: false,
    doneSent: false,
  };
}

export function createClaudeDownstreamContext(): ClaudeDownstreamContext {
  return {
    messageStarted: false,
    contentBlockStarted: false,
    doneSent: false,
  };
}

function buildClaudeMessageId(sourceId: string): string {
  if (sourceId.startsWith('msg_')) return sourceId;
  const sanitized = sourceId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `msg_${sanitized || Date.now()}`;
}

function serializeSse(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  if (event) {
    return `event: ${event}\ndata: ${payload}\n\n`;
  }
  return `data: ${payload}\n\n`;
}

function extractAssistantContent(choice: any): string {
  const messageContent = choice?.message?.content;
  const parsedMessage = extractTextAndReasoning(messageContent).content;
  if (parsedMessage) return parsedMessage;

  const content = extractTextAndReasoning(choice?.content).content;
  if (content) return content;

  if (typeof choice?.text === 'string' && choice.text.length > 0) return choice.text;
  if (typeof choice?.completion === 'string' && choice.completion.length > 0) return choice.completion;
  if (typeof choice?.output_text === 'string' && choice.output_text.length > 0) return choice.output_text;
  if (typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0) return choice.delta.content;

  return '';
}

function extractAssistantReasoning(choice: any): string {
  const message = choice?.message || {};
  const direct = [
    message.reasoning_content,
    message.reasoning,
    choice?.reasoning_content,
    choice?.reasoning,
  ].find((item) => typeof item === 'string' && item.length > 0);

  if (typeof direct === 'string') return direct;

  const parsed = extractTextAndReasoning(message.content);
  if (parsed.reasoning) return parsed.reasoning;

  const nested = extractTextAndReasoning(choice?.content).reasoning;
  if (nested) return nested;

  return '';
}

function parseClaudeMessageContent(content: unknown): string {
  return extractTextAndReasoning(content).content;
}

function parseResponsesOutputText(payload: Record<string, unknown>): string {
  const direct = typeof payload.output_text === 'string' ? payload.output_text : '';
  if (direct) return direct;

  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const parsed = extractTextAndReasoning(item.content ?? item);
    if (parsed.content) parts.push(parsed.content);
  }

  return parts.join('\n\n');
}

function convertClaudeRequestToOpenAiBody(body: Record<string, unknown>): {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string }>;
  payload: Record<string, unknown>;
} {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const stream = body.stream === true;

  const messages: Array<{ role: string; content: string }> = [];

  const appendMessage = (role: string, content: unknown) => {
    const text = parseClaudeMessageContent(content);
    if (!text) return;
    messages.push({ role, content: text });
  };

  const system = body.system;
  if (typeof system === 'string') {
    appendMessage('system', system);
  } else if (Array.isArray(system)) {
    const merged = system.map((item) => parseClaudeMessageContent(item)).filter((item) => item.length > 0).join('\n\n');
    if (merged) appendMessage('system', merged);
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of rawMessages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === 'string' ? message.role : 'user';
    const mappedRole = role === 'assistant' || role === 'system' ? role : 'user';
    appendMessage(mappedRole, message.content);
  }

  const payload: Record<string, unknown> = {
    model,
    stream,
    messages,
  };

  const temperature = pickFiniteNumber(body.temperature);
  if (temperature !== undefined) payload.temperature = temperature;

  const topP = pickFiniteNumber(body.top_p);
  if (topP !== undefined) payload.top_p = topP;

  const maxTokens = pickFiniteNumber(body.max_tokens);
  if (maxTokens !== undefined) {
    payload.max_tokens = maxTokens;
  } else {
    payload.max_tokens = 4096;
  }

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    payload.stop = body.stop_sequences;
  }

  if (body.tools !== undefined) payload.tools = body.tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;

  return { model, stream, messages, payload };
}

export function parseDownstreamChatRequest(
  body: unknown,
  format: DownstreamFormat,
): { value?: ParsedDownstreamChatRequest; error?: { statusCode: number; payload: unknown } } {
  const raw = isRecord(body) ? body : {};

  if (format === 'claude') {
    const converted = convertClaudeRequestToOpenAiBody(raw);
    if (!converted.model) {
      return {
        error: {
          statusCode: 400,
          payload: { error: { message: 'model is required', type: 'invalid_request_error' } },
        },
      };
    }

    if (converted.messages.length <= 0) {
      return {
        error: {
          statusCode: 400,
          payload: { error: { message: 'messages is required', type: 'invalid_request_error' } },
        },
      };
    }

    return {
      value: {
        requestedModel: converted.model,
        isStream: converted.stream,
        upstreamBody: converted.payload,
      },
    };
  }

  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) {
    return {
      error: {
        statusCode: 400,
        payload: { error: { message: 'model is required', type: 'invalid_request_error' } },
      },
    };
  }

  const hasMessages = Array.isArray(raw.messages) && raw.messages.length > 0;
  if (!hasMessages) {
    const hint = raw.input !== undefined
      ? 'messages is required for /v1/chat/completions. For Responses payload, use /v1/responses.'
      : 'messages is required';
    return {
      error: {
        statusCode: 400,
        payload: { error: { message: hint, type: 'invalid_request_error' } },
      },
    };
  }

  return {
    value: {
      requestedModel: model,
      isStream: raw.stream === true,
      upstreamBody: raw,
    },
  };
}

export function normalizeUpstreamFinalResponse(
  payload: unknown,
  fallbackModel: string,
  fallbackText = '',
): NormalizedFinalResponse {
  const now = Math.floor(Date.now() / 1000);
  const fallbackId = `chatcmpl-meta-${Date.now()}`;

  if (isRecord(payload) && Array.isArray(payload.choices)) {
    const choice = payload.choices[0] ?? {};
    const content = extractAssistantContent(choice) || extractAssistantContent(payload);
    const reasoning = extractAssistantReasoning(choice) || extractAssistantReasoning(payload);
    return {
      id: isNonEmptyString(payload.id) ? payload.id : fallbackId,
      model: isNonEmptyString(payload.model) ? payload.model : fallbackModel,
      created: ensureIntegerTimestamp(payload.created, now),
      content: content || fallbackText,
      reasoningContent: reasoning,
      finishReason: normalizeStopReason(choice?.finish_reason ?? payload.stop_reason) || 'stop',
    };
  }

  if (isRecord(payload) && typeof payload.type === 'string' && payload.type === 'message') {
    return {
      id: isNonEmptyString(payload.id) ? payload.id : fallbackId,
      model: isNonEmptyString(payload.model) ? payload.model : fallbackModel,
      created: now,
      content: parseClaudeMessageContent(payload.content) || fallbackText,
      reasoningContent: extractTextAndReasoning(payload.content).reasoning,
      finishReason: normalizeStopReason(payload.stop_reason) || 'stop',
    };
  }

  if (isRecord(payload) && ((payload as any).object === 'response' || Array.isArray((payload as any).output))) {
    return {
      id: isNonEmptyString(payload.id) ? payload.id : fallbackId,
      model: isNonEmptyString(payload.model) ? payload.model : fallbackModel,
      created: ensureIntegerTimestamp(payload.created, now),
      content: parseResponsesOutputText(payload) || fallbackText,
      reasoningContent: '',
      finishReason: normalizeStopReason(payload.finish_reason ?? payload.status) || 'stop',
    };
  }

  if (isRecord(payload) && Array.isArray(payload.candidates)) {
    const candidate = payload.candidates[0] || {};
    const parsedCandidate = extractTextAndReasoning(candidate?.content?.parts || candidate?.content);
    return {
      id: isNonEmptyString((payload as any).responseId) ? (payload as any).responseId : fallbackId,
      model: isNonEmptyString((payload as any).modelVersion)
        ? (payload as any).modelVersion
        : fallbackModel,
      created: now,
      content: parsedCandidate.content || fallbackText,
      reasoningContent: parsedCandidate.reasoning,
      finishReason: normalizeStopReason(candidate?.finishReason || (payload as any).finishReason) || 'stop',
    };
  }

  if (typeof payload === 'string' && payload.trim()) {
    return {
      id: fallbackId,
      model: fallbackModel,
      created: now,
      content: payload,
      reasoningContent: '',
      finishReason: 'stop',
    };
  }

  return {
    id: fallbackId,
    model: fallbackModel,
    created: now,
    content: fallbackText,
    reasoningContent: '',
    finishReason: 'stop',
  };
}

export function normalizeUpstreamStreamEvent(
  payload: unknown,
  context: StreamTransformContext,
  fallbackModel: string,
): NormalizedStreamEvent {
  if (!isRecord(payload)) return {};

  if (Array.isArray(payload.choices)) {
    if (isNonEmptyString(payload.id)) context.id = payload.id;
    if (isNonEmptyString(payload.model)) context.model = payload.model;
    context.created = ensureIntegerTimestamp(payload.created, context.created);

    const choice = payload.choices[0] ?? {};
    const delta = isRecord(choice?.delta) ? choice.delta : {};
    const deltaParsed = extractTextAndReasoning(delta.content ?? delta);

    const contentDelta =
      deltaParsed.content
      || (typeof choice?.message?.content === 'string' ? choice.message.content : '')
      || '';

    const reasoningDelta =
      (typeof (delta as any).reasoning_content === 'string' ? (delta as any).reasoning_content : '')
      || (typeof (delta as any).reasoning === 'string' ? (delta as any).reasoning : '')
      || deltaParsed.reasoning
      || '';

    return {
      role: (delta as any).role === 'assistant' ? 'assistant' : undefined,
      contentDelta: contentDelta || undefined,
      reasoningDelta: reasoningDelta || undefined,
      finishReason: normalizeStopReason(choice?.finish_reason),
    };
  }

  const type = typeof payload.type === 'string' ? payload.type : '';
  if (type.startsWith('response.output_text')) {
    const deltaText = typeof payload.delta === 'string'
      ? payload.delta
      : extractTextAndReasoning(payload.delta).content;
    return {
      contentDelta: deltaText || undefined,
    };
  }

  if (type === 'response.completed' && isRecord((payload as any).response)) {
    const responsePayload = (payload as any).response as Record<string, unknown>;
    if (isNonEmptyString(responsePayload.id)) context.id = responsePayload.id;
    if (isNonEmptyString(responsePayload.model)) context.model = responsePayload.model;
    return {
      finishReason: normalizeStopReason(responsePayload.status) || 'stop',
      done: true,
    };
  }

  const message = isRecord(payload.message) ? payload.message : null;

  if (message) {
    if (isNonEmptyString(message.id)) context.id = message.id;
    if (isNonEmptyString(message.model)) context.model = message.model;
  }
  if (!context.model) context.model = fallbackModel;

  if (type === 'message_start') {
    return { role: 'assistant' };
  }

  if (type === 'content_block_start') {
    const parsed = extractTextAndReasoning(payload.content_block);
    return {
      contentDelta: parsed.content || undefined,
      reasoningDelta: parsed.reasoning || undefined,
    };
  }

  if (type === 'content_block_delta') {
    const delta = isRecord(payload.delta) ? payload.delta : {};
    const deltaType = typeof delta.type === 'string' ? delta.type : '';
    const parsed = extractTextAndReasoning(delta);

    if (deltaType === 'thinking_delta') {
      return {
        reasoningDelta: parsed.content || parsed.reasoning || undefined,
      };
    }

    return {
      contentDelta: parsed.content || undefined,
      reasoningDelta: parsed.reasoning || undefined,
    };
  }

  if (type === 'message_delta') {
    const delta = isRecord(payload.delta) ? payload.delta : {};
    return {
      finishReason: normalizeStopReason(delta.stop_reason ?? payload.stop_reason),
    };
  }

  if (type === 'message_stop') {
    return { done: true };
  }

  if (Array.isArray(payload.candidates)) {
    const candidate = payload.candidates[0] || {};
    const parsed = extractTextAndReasoning((candidate as any).content?.parts || (candidate as any).content);

    if (isNonEmptyString((payload as any).modelVersion)) {
      context.model = (payload as any).modelVersion;
    } else if (!context.model) {
      context.model = fallbackModel;
    }

    return {
      contentDelta: parsed.content || undefined,
      reasoningDelta: parsed.reasoning || undefined,
      finishReason: normalizeStopReason((candidate as any).finishReason || (payload as any).finishReason),
    };
  }

  const fallback = extractTextAndReasoning(payload);
  return {
    contentDelta: fallback.content || undefined,
    reasoningDelta: fallback.reasoning || undefined,
  };
}

function buildOpenAiStreamChunk(
  context: StreamTransformContext,
  event: NormalizedStreamEvent,
): Record<string, unknown> | null {
  const delta: Record<string, unknown> = {};
  const isInitialAssistantRoleOnlyEvent = (
    !context.roleSent
    && event.role === 'assistant'
    && !event.contentDelta
    && !event.reasoningDelta
  );

  if (!context.roleSent && (event.role === 'assistant' || event.contentDelta || event.reasoningDelta)) {
    delta.role = 'assistant';
    context.roleSent = true;
  } else if (event.role === 'assistant') {
    delta.role = 'assistant';
    context.roleSent = true;
  }

  if (event.contentDelta) {
    delta.content = event.contentDelta;
  }

  if (event.reasoningDelta) {
    delta.reasoning_content = event.reasoningDelta;
  }

  // Some OpenAI-compatible clients (e.g. OpenWebUI) expect starter chunk to include empty content.
  if (isInitialAssistantRoleOnlyEvent) {
    delta.content = '';
  }

  const finishReason = event.finishReason || null;
  const hasDelta = Object.keys(delta).length > 0;
  if (!hasDelta && !finishReason) return null;

  return {
    id: context.id,
    object: 'chat.completion.chunk',
    created: context.created,
    model: context.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
}

function ensureClaudeStartEvents(
  context: StreamTransformContext,
  claudeContext: ClaudeDownstreamContext,
): string[] {
  if (claudeContext.messageStarted) return [];

  claudeContext.messageStarted = true;
  const payload = {
    type: 'message_start',
    message: {
      id: buildClaudeMessageId(context.id),
      type: 'message',
      role: 'assistant',
      model: context.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  };

  return [serializeSse('message_start', payload)];
}

function ensureClaudeContentBlockStart(
  claudeContext: ClaudeDownstreamContext,
): string[] {
  if (claudeContext.contentBlockStarted) return [];
  claudeContext.contentBlockStarted = true;

  return [serializeSse('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'text',
      text: '',
    },
  })];
}

function buildClaudeDoneEvents(
  context: StreamTransformContext,
  claudeContext: ClaudeDownstreamContext,
  finishReason?: string | null,
): string[] {
  if (claudeContext.doneSent) return [];

  const events: string[] = [];
  events.push(...ensureClaudeStartEvents(context, claudeContext));

  if (claudeContext.contentBlockStarted) {
    events.push(serializeSse('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }));
    claudeContext.contentBlockStarted = false;
  }

  events.push(serializeSse('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: toClaudeStopReason(finishReason),
      stop_sequence: null,
    },
    usage: {
      output_tokens: 0,
    },
  }));
  events.push(serializeSse('message_stop', { type: 'message_stop' }));

  claudeContext.doneSent = true;
  return events;
}

export function serializeNormalizedStreamEvent(
  downstreamFormat: DownstreamFormat,
  event: NormalizedStreamEvent,
  context: StreamTransformContext,
  claudeContext: ClaudeDownstreamContext,
): string[] {
  if (downstreamFormat === 'openai') {
    const chunk = buildOpenAiStreamChunk(context, event);
    return chunk ? [serializeSse('', chunk)] : [];
  }

  if (event.done || event.finishReason) {
    return buildClaudeDoneEvents(context, claudeContext, event.finishReason);
  }

  const events: string[] = [];
  if (event.role === 'assistant' || event.contentDelta || event.reasoningDelta) {
    events.push(...ensureClaudeStartEvents(context, claudeContext));
  }

  const mergedText = joinNonEmpty([
    event.reasoningDelta || '',
    event.contentDelta || '',
  ]);

  if (mergedText) {
    events.push(...ensureClaudeContentBlockStart(claudeContext));
    events.push(serializeSse('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: mergedText,
      },
    }));
  }

  return events;
}

export function serializeStreamDone(
  downstreamFormat: DownstreamFormat,
  context: StreamTransformContext,
  claudeContext: ClaudeDownstreamContext,
): string[] {
  if (context.doneSent) return [];
  context.doneSent = true;

  if (downstreamFormat === 'openai') {
    return [serializeSse('', '[DONE]')];
  }

  return buildClaudeDoneEvents(context, claudeContext, 'stop');
}

export function serializeFinalResponse(
  downstreamFormat: DownstreamFormat,
  normalized: NormalizedFinalResponse,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): Record<string, unknown> {
  if (downstreamFormat === 'claude') {
    return {
      id: buildClaudeMessageId(normalized.id),
      type: 'message',
      role: 'assistant',
      model: normalized.model,
      content: [{
        type: 'text',
        text: normalized.content,
      }],
      stop_reason: toClaudeStopReason(normalized.finishReason),
      stop_sequence: null,
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
      },
    };
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: normalized.content,
  };
  if (normalized.reasoningContent) {
    message.reasoning_content = normalized.reasoningContent;
  }

  return {
    id: normalized.id,
    object: 'chat.completion',
    created: normalized.created,
    model: normalized.model,
    choices: [{
      index: 0,
      message,
      finish_reason: normalizeStopReason(normalized.finishReason) || 'stop',
    }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

export function buildSyntheticOpenAiChunks(normalized: NormalizedFinalResponse): Array<Record<string, unknown>> {
  const startChunk: Record<string, unknown> = {
    id: normalized.id,
    object: 'chat.completion.chunk',
    created: normalized.created,
    model: normalized.model,
    choices: [{
      index: 0,
      delta: normalized.content
        ? { role: 'assistant', content: normalized.content }
        : { role: 'assistant' },
      finish_reason: null,
    }],
  };

  if (normalized.reasoningContent) {
    (startChunk.choices as any[])[0].delta.reasoning_content = normalized.reasoningContent;
  }

  const endChunk = {
    id: normalized.id,
    object: 'chat.completion.chunk',
    created: normalized.created,
    model: normalized.model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: normalizeStopReason(normalized.finishReason) || 'stop',
    }],
  };

  return [startChunk, endChunk];
}

export function pullSseEventsWithDone(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const events: ParsedSseEvent[] = [];
  let rest = normalized;

  while (true) {
    const boundary = rest.indexOf('\n\n');
    if (boundary < 0) break;

    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    if (!block.trim()) continue;

    const lines = block.split('\n');
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length <= 0) continue;

    events.push({
      event: eventName,
      data: dataLines.join('\n').trim(),
    });
  }

  return { events, rest };
}
