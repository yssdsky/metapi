import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const estimateProxyCostMock = vi.fn(async (_arg?: any) => 0);
const fetchModelPricingCatalogMock = vi.fn(async (_arg?: any): Promise<any> => null);
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: () => ({
    run: () => undefined,
  }),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
  fetchModelPricingCatalog: (arg: any) => fetchModelPricingCatalogMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: () => false,
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
  },
  schema: {
    proxyLogs: {},
  },
}));

describe('chat proxy stream behavior', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { chatProxyRoute, claudeMessagesProxyRoute } = await import('./chat.js');
    const { responsesProxyRoute } = await import('./responses.js');
    app = Fastify();
    await app.register(chatProxyRoute);
    await app.register(claudeMessagesProxyRoute);
    await app.register(responsesProxyRoute);
  });

  beforeEach(() => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    estimateProxyCostMock.mockClear();
    fetchModelPricingCatalogMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    dbInsertMock.mockClear();

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'demo-site', url: 'https://upstream.example.com' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });
    selectNextChannelMock.mockReturnValue(null);
    fetchModelPricingCatalogMock.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app.close();
  });

  it('converts non-SSE upstream streaming responses into SSE events', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-demo',
      object: 'chat.completion',
      created: 1_706_000_000,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello from upstream' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: ');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('hello from upstream');
    expect(response.body).toContain('data: [DONE]');
  });

  it('returns clear 400 when /v1/chat/completions receives responses-style input without messages', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body?.error?.type).toBe('invalid_request_error');
    expect(body?.error?.message).toContain('/v1/responses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sets anti-buffering SSE headers for streamed chat responses', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-transform');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('"delta":{"role":"assistant","content":"hello"}');
    expect(response.body).toContain('data: [DONE]');
  });

  it('normalizes anthropic-style SSE events into OpenAI chunks for clients like OpenWebUI', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","model":"claude-opus-4-6"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'who are you' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('"chat.completion.chunk"');
    expect(response.body).toContain('"delta":{"content":"hello"}');
    expect(response.body).toContain('"finish_reason":"stop"');
    expect(response.body).toContain('data: [DONE]');
  });

  it('emits OpenAI-compatible assistant starter chunk for anthropic message_start events', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_compat","model":"claude-opus-4-6"}}\n\n'));
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"compat"}}\n\n'));
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'compat test' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"delta":{"role":"assistant","content":""}');
    expect(response.body).toContain('"delta":{"content":"compat"}');
    expect(response.body).toContain('data: [DONE]');
  });

  it('converts OpenAI non-stream responses into Claude message format on /v1/messages', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      created: 1_706_000_001,
      model: 'claude-opus-4-6',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello from claude format' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 120, completion_tokens: 16, total_tokens: 136 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-opus-4-6');
    expect(body.content?.[0]?.type).toBe('text');
    expect(body.content?.[0]?.text).toContain('hello from claude format');
    expect(body.stop_reason).toBe('end_turn');
  });

  it('converts OpenAI SSE chunks into Claude stream events on /v1/messages', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"claude-opus-4-6","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"claude-opus-4-6","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","model":"claude-opus-4-6","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'claude-opus-4-6',
        stream: true,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain('event: content_block_delta');
    expect(response.body).toContain('\"text\":\"hello\"');
    expect(response.body).toContain('event: message_stop');
  });

  it('serves /v1/responses via protocol translation when upstream is OpenAI-compatible', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_123',
      object: 'response',
      output_text: 'hello from responses',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('hello from responses');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl, options] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/chat/completions');
    const forwarded = JSON.parse(options.body);
    expect(forwarded.model).toBe('upstream-gpt');
  });

  it('passes through /v1/responses SSE payloads', async () => {
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    fetchMock.mockResolvedValue(new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2',
        input: 'hello',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('response.output_text.delta');
    expect(response.body).toContain('[DONE]');
  });

  it('routes /v1/responses to /v1/messages when upstream catalog is anthropic-only', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['anthropic'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_900',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'hello from anthropic messages upstream' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('response');
    expect(body.output_text).toContain('hello from anthropic messages upstream');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('forces anyrouter platform to prefer /v1/messages even when catalog says openai', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'anyrouter-site', url: 'https://anyrouter.example.com', platform: 'anyrouter' },
      account: { id: 33, username: 'demo-user' },
      tokenName: 'default',
      tokenValue: 'sk-demo',
      actualModel: 'upstream-gpt',
    });
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['openai'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_anyrouter',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'anyrouter prefers messages' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('anyrouter prefers messages');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('chooses /v1/messages upstream when catalog indicates messages-only endpoint support', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'msg_100',
      type: 'message',
      model: 'upstream-gpt',
      content: [{ type: 'text', text: 'hello from messages only' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('hello from messages only');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/messages');
  });

  it('prefers OpenAI-compatible endpoint when catalog uses generic openai/anthropic labels', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['anthropic', 'openai'],
        },
      ],
      groupRatio: {},
    });

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-openai-first',
      object: 'chat.completion',
      created: 1_706_000_002,
      model: 'upstream-gpt',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'hello from openai endpoint' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('hello from openai endpoint');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [targetUrl] = fetchMock.mock.calls[0] as [string, any];
    expect(targetUrl).toContain('/v1/chat/completions');
  });

  it('falls back to /v1/messages when catalog only declares openai and chat endpoint fails', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['openai'],
        },
      ],
      groupRatio: {},
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'openai_error',
          type: 'bad_response_status_code',
          code: 'bad_response_status_code',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_fallback_500',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'fallback to messages from openai-only catalog' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('fallback to messages from openai-only catalog');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
  });

  it('downgrades endpoint when upstream returns convert_request_failed/not implemented', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions', '/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'not implemented (request id: abc123)',
          type: 'new_api_error',
          code: 'convert_request_failed',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_200',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'fallback from messages' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('fallback from messages');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
  });

  it('downgrades endpoint when upstream returns openai_error bad_response_status_code', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'upstream-gpt',
          supportedEndpointTypes: ['/v1/chat/completions', '/v1/messages'],
        },
      ],
      groupRatio: {},
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'openai_error',
          type: 'bad_response_status_code',
          code: 'bad_response_status_code',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'msg_300',
        type: 'message',
        model: 'upstream-gpt',
        content: [{ type: 'text', text: 'fallback from bad_response_status_code' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'claude-haiku-4-5-20251001',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body?.choices?.[0]?.message?.content).toContain('fallback from bad_response_status_code');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toContain('/v1/chat/completions');
    expect(secondUrl).toContain('/v1/messages');
  });
});
