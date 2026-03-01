import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import type { DownstreamFormat } from './chatFormats.js';

export type UpstreamEndpoint = 'chat' | 'messages' | 'responses';

type ChannelContext = {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isRecord(item)) return '';
        const text = asTrimmedString(item.text ?? item.content ?? item.output_text);
        return text;
      })
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (isRecord(content)) {
    const text = asTrimmedString(content.text ?? content.content ?? content.output_text);
    return text;
  }
  return '';
}

function convertOpenAiBodyToMessagesBody(
  openaiBody: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemContents: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asTrimmedString(item.role) || 'user';
    const content = normalizeContentText(item.content);
    if (!content) continue;

    if (role === 'system') {
      systemContents.push(content);
      continue;
    }

    messages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  const body: Record<string, unknown> = {
    model: modelName,
    stream,
    messages,
    max_tokens: toFiniteNumber(openaiBody.max_tokens) ?? 4096,
  };

  if (systemContents.length > 0) {
    body.system = systemContents.join('\n\n');
  }

  const temperature = toFiniteNumber(openaiBody.temperature);
  if (temperature !== null) body.temperature = temperature;

  const topP = toFiniteNumber(openaiBody.top_p);
  if (topP !== null) body.top_p = topP;

  if (Array.isArray(openaiBody.stop) && openaiBody.stop.length > 0) {
    body.stop_sequences = openaiBody.stop;
  }

  if (openaiBody.tools !== undefined) body.tools = openaiBody.tools;
  if (openaiBody.tool_choice !== undefined) body.tool_choice = openaiBody.tool_choice;
  return body;
}

function convertOpenAiBodyToResponsesBody(
  openaiBody: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const rawMessages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  const systemContents: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const item of rawMessages) {
    if (!isRecord(item)) continue;
    const role = asTrimmedString(item.role) || 'user';
    const content = normalizeContentText(item.content);
    if (!content) continue;

    if (role === 'system') {
      systemContents.push(content);
      continue;
    }

    messages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  const body: Record<string, unknown> = {
    model: modelName,
    stream,
    max_output_tokens: toFiniteNumber(openaiBody.max_tokens) ?? 4096,
  };

  if (messages.length === 1 && messages[0].role === 'user' && systemContents.length === 0) {
    body.input = messages[0].content;
  } else {
    body.input = messages;
    if (systemContents.length > 0) {
      body.instructions = systemContents.join('\n\n');
    }
  }

  const temperature = toFiniteNumber(openaiBody.temperature);
  if (temperature !== null) body.temperature = temperature;

  const topP = toFiniteNumber(openaiBody.top_p);
  if (topP !== null) body.top_p = topP;

  if (openaiBody.tools !== undefined) body.tools = openaiBody.tools;
  if (openaiBody.tool_choice !== undefined) body.tool_choice = openaiBody.tool_choice;
  return body;
}

function normalizeEndpointTypes(value: unknown): UpstreamEndpoint[] {
  const raw = asTrimmedString(value).toLowerCase();
  if (!raw) return [];

  const normalized = new Set<UpstreamEndpoint>();

  if (
    raw.includes('/v1/messages')
    || raw === 'messages'
    || raw.includes('anthropic')
    || raw.includes('claude')
  ) {
    normalized.add('messages');
  }

  if (
    raw.includes('/v1/responses')
    || raw === 'responses'
    || raw.includes('response')
  ) {
    // Treat responses family as OpenAI-compatible for upstream selection.
    normalized.add('chat');
  }

  if (
    raw.includes('/v1/chat/completions')
    || raw.includes('chat/completions')
    || raw === 'chat'
    || raw === 'chat_completions'
    || raw === 'completions'
    || raw.includes('chat')
  ) {
    normalized.add('chat');
  }

  // Some upstreams return protocol families instead of concrete endpoint paths.
  if (raw === 'openai' || raw.includes('openai')) {
    normalized.add('chat');
  }

  return Array.from(normalized);
}

function preferredEndpointOrder(downstreamFormat: DownstreamFormat): UpstreamEndpoint[] {
  return downstreamFormat === 'claude'
    ? ['messages', 'chat']
    : ['chat', 'messages'];
}

export async function resolveUpstreamEndpointCandidates(
  context: ChannelContext,
  modelName: string,
  downstreamFormat: DownstreamFormat,
): Promise<UpstreamEndpoint[]> {
  if ((context.site.platform || '').toLowerCase() === 'anyrouter') {
    // anyrouter deployments are effectively anthropic-protocol first.
    return ['messages', 'chat'];
  }

  const preferred = preferredEndpointOrder(downstreamFormat);

  try {
    const catalog = await fetchModelPricingCatalog({
      site: {
        id: context.site.id,
        url: context.site.url,
        platform: context.site.platform,
        apiKey: context.site.apiKey ?? null,
      },
      account: {
        id: context.account.id,
        accessToken: context.account.accessToken ?? null,
        apiToken: context.account.apiToken ?? null,
      },
      modelName,
      totalTokens: 0,
    });

    if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return preferred;
    }

    const matched = catalog.models.find((item) =>
      asTrimmedString(item?.modelName).toLowerCase() === modelName.toLowerCase(),
    );
    if (!matched) return preferred;

    const supportedRaw = Array.isArray(matched.supportedEndpointTypes) ? matched.supportedEndpointTypes : [];
    const supported = new Set<UpstreamEndpoint>();
    for (const endpoint of supportedRaw) {
      const normalizedList = normalizeEndpointTypes(endpoint);
      for (const normalized of normalizedList) {
        supported.add(normalized);
      }
    }

    if (supported.size === 0) return preferred;

    const filtered = preferred.filter((endpoint) => supported.has(endpoint));
    if (filtered.length === 0) return preferred;

    // Keep non-catalog endpoints as best-effort fallbacks because some
    // upstreams expose incomplete/incorrect endpoint metadata.
    const fallback = preferred.filter((endpoint) => !filtered.includes(endpoint));
    return [...filtered, ...fallback];
  } catch {
    return preferred;
  }
}

export function buildUpstreamEndpointRequest(input: {
  endpoint: UpstreamEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  openaiBody: Record<string, unknown>;
}): {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const commonHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${input.tokenValue}`,
  };

  if (input.endpoint === 'messages') {
    return {
      path: '/v1/messages',
      headers: {
        ...commonHeaders,
        'x-api-key': input.tokenValue,
        'anthropic-version': '2023-06-01',
      },
      body: convertOpenAiBodyToMessagesBody(input.openaiBody, input.modelName, input.stream),
    };
  }

  if (input.endpoint === 'responses') {
    return {
      path: '/v1/responses',
      headers: commonHeaders,
      body: convertOpenAiBodyToResponsesBody(input.openaiBody, input.modelName, input.stream),
    };
  }

  return {
    path: '/v1/chat/completions',
    headers: commonHeaders,
    body: {
      ...input.openaiBody,
      model: input.modelName,
      stream: input.stream,
    },
  };
}

export function isEndpointDowngradeError(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 400) return false;
  const text = (upstreamErrorText || '').toLowerCase();
  if (!text) return false;

  let parsedCode = '';
  let parsedType = '';
  let parsedMessage = '';
  try {
    const parsed = JSON.parse(upstreamErrorText || '{}') as Record<string, unknown>;
    const error = (parsed.error && typeof parsed.error === 'object')
      ? parsed.error as Record<string, unknown>
      : parsed;
    parsedCode = asTrimmedString(error.code).toLowerCase();
    parsedType = asTrimmedString(error.type).toLowerCase();
    parsedMessage = asTrimmedString(error.message).toLowerCase();
  } catch {
    parsedCode = '';
    parsedType = '';
    parsedMessage = '';
  }

  return (
    text.includes('convert_request_failed')
    || text.includes('not implemented')
    || text.includes('api not implemented')
    || text.includes('unsupported legacy protocol')
    || parsedCode === 'convert_request_failed'
    || parsedCode === 'bad_response_status_code'
    || parsedType === 'bad_response_status_code'
    || parsedMessage.includes('bad_response_status_code')
  );
}
