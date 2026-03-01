import { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { fetch } from 'undici';
import { config } from '../../config.js';

type TestChatMessage = { role: string; content: string };
type TestTargetFormat = 'openai' | 'claude' | 'responses';

type TestChatRequestBody = {
  model?: string;
  messages?: TestChatMessage[];
  targetFormat?: TestTargetFormat;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

type ValidatedTestChatPayload = {
  model: string;
  messages: TestChatMessage[];
  targetFormat: TestTargetFormat;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

type TestChatJobStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

type TestChatJob = {
  id: string;
  status: TestChatJobStatus;
  payload: ValidatedTestChatPayload;
  result?: unknown;
  error?: unknown;
  controller?: AbortController | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_CLEANUP_INTERVAL_MS = 60 * 1000;
const jobs = new Map<string, TestChatJob>();

class UpstreamProxyError extends Error {
  statusCode: number;
  responsePayload: unknown;

  constructor(statusCode: number, responsePayload: unknown) {
    super(`Upstream request failed with status ${statusCode}`);
    this.name = 'UpstreamProxyError';
    this.statusCode = statusCode;
    this.responsePayload = responsePayload;
  }
}

const normalizeErrorPayload = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text, type: 'upstream_error' } };
  }
};

const validatePayload = (
  body: TestChatRequestBody,
  reply: FastifyReply,
): ValidatedTestChatPayload | null => {
  if (!body.model || body.model.trim().length === 0) {
    reply.code(400).send({ error: 'model is required' });
    return null;
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    reply.code(400).send({ error: 'messages is required' });
    return null;
  }

  const targetFormat: TestTargetFormat = body.targetFormat === 'claude'
    ? 'claude'
    : body.targetFormat === 'responses'
      ? 'responses'
      : 'openai';

  return {
    model: body.model,
    messages: body.messages,
    targetFormat,
    stream: body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    frequency_penalty: body.frequency_penalty,
    presence_penalty: body.presence_penalty,
    seed: body.seed,
  };
};

const convertOpenAiPayloadToClaudeBody = (
  payload: ValidatedTestChatPayload,
  forceStream: boolean,
): Record<string, unknown> => {
  const systemContents: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const message of payload.messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) continue;

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
    model: payload.model,
    stream: forceStream,
    max_tokens: typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)
      ? payload.max_tokens
      : 4096,
    messages,
  };

  if (systemContents.length > 0) {
    body.system = systemContents.join('\n\n');
  }

  if (typeof payload.temperature === 'number' && Number.isFinite(payload.temperature)) {
    body.temperature = payload.temperature;
  }
  if (typeof payload.top_p === 'number' && Number.isFinite(payload.top_p)) {
    body.top_p = payload.top_p;
  }

  return body;
};

const convertOpenAiPayloadToResponsesBody = (
  payload: ValidatedTestChatPayload,
  forceStream: boolean,
): Record<string, unknown> => {
  const systemContents: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const message of payload.messages) {
    const role = typeof message.role === 'string' ? message.role : 'user';
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) continue;

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
    model: payload.model,
    stream: forceStream,
  };

  if (messages.length === 1 && messages[0].role === 'user' && systemContents.length === 0) {
    body.input = messages[0].content;
  } else {
    body.input = messages;
    if (systemContents.length > 0) {
      body.instructions = systemContents.join('\n\n');
    }
  }

  if (typeof payload.temperature === 'number' && Number.isFinite(payload.temperature)) {
    body.temperature = payload.temperature;
  }
  if (typeof payload.top_p === 'number' && Number.isFinite(payload.top_p)) {
    body.top_p = payload.top_p;
  }
  body.max_output_tokens = typeof payload.max_tokens === 'number' && Number.isFinite(payload.max_tokens)
    ? payload.max_tokens
    : 4096;

  return body;
};

const buildUpstreamRequest = (
  payload: ValidatedTestChatPayload,
  forceStream: boolean,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } => {
  if (payload.targetFormat === 'claude') {
    return {
      url: `http://127.0.0.1:${config.port}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.proxyToken,
        'anthropic-version': '2023-06-01',
      },
      body: convertOpenAiPayloadToClaudeBody(payload, forceStream),
    };
  }

  if (payload.targetFormat === 'responses') {
    return {
      url: `http://127.0.0.1:${config.port}/v1/responses`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.proxyToken}`,
      },
      body: convertOpenAiPayloadToResponsesBody(payload, forceStream),
    };
  }

  const { targetFormat: _targetFormat, ...openAiPayload } = payload;
  return {
    url: `http://127.0.0.1:${config.port}/v1/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.proxyToken}`,
    },
    body: { ...openAiPayload, stream: forceStream },
  };
};

const requestUpstreamChat = async (
  payload: ValidatedTestChatPayload,
  signal?: AbortSignal,
  forceStream = false,
): Promise<unknown> => {
  const upstreamRequest = buildUpstreamRequest(payload, forceStream);
  const upstream = await fetch(upstreamRequest.url, {
    method: 'POST',
    headers: upstreamRequest.headers,
    body: JSON.stringify(upstreamRequest.body),
    signal,
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    throw new UpstreamProxyError(upstream.status, normalizeErrorPayload(text));
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const cleanupExpiredJobs = () => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (job.expiresAt <= now) {
      jobs.delete(jobId);
    }
  }
};

const runJob = async (jobId: string) => {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'pending') return;

  const controller = new AbortController();
  job.controller = controller;

  try {
    const result = await requestUpstreamChat(job.payload, controller.signal);
    const current = jobs.get(jobId);
    if (!current) return;
    current.controller = null;
    current.status = 'succeeded';
    current.result = result;
    current.updatedAt = Date.now();
    current.expiresAt = current.updatedAt + JOB_TTL_MS;
  } catch (error) {
    const current = jobs.get(jobId);
    if (!current) return;
    current.controller = null;

    if ((error as any)?.name === 'AbortError') {
      current.status = 'cancelled';
      current.error = { error: { message: 'job cancelled', type: 'cancelled' } };
      current.updatedAt = Date.now();
      current.expiresAt = current.updatedAt + 30_000;
      return;
    }

    current.status = 'failed';
    current.error = error instanceof UpstreamProxyError
      ? error.responsePayload
      : { error: { message: (error as any)?.message || 'proxy request failed', type: 'server_error' } };
    current.updatedAt = Date.now();
    current.expiresAt = current.updatedAt + JOB_TTL_MS;
  }
};

export async function testRoutes(app: FastifyInstance) {
  const cleanupTimer = setInterval(cleanupExpiredJobs, JOB_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
  });

  app.post<{ Body: TestChatRequestBody }>(
    '/api/test/chat',
    async (request, reply) => {
      const body = request.body || {};
      const payload = validatePayload(body, reply);
      if (!payload) return;

      try {
        const data = await requestUpstreamChat(payload, undefined, false);
        return reply.send(data);
      } catch (error) {
        if (error instanceof UpstreamProxyError) {
          return reply.code(error.statusCode).send(error.responsePayload);
        }
        return reply.code(502).send({
          error: {
            message: (error as any)?.message || 'proxy request failed',
            type: 'server_error',
          },
        });
      }
    },
  );

  app.post<{ Body: TestChatRequestBody }>(
    '/api/test/chat/stream',
    async (request, reply) => {
      const body = request.body || {};
      const payload = validatePayload(body, reply);
      if (!payload) return;

      const controller = new AbortController();
      const abortUpstream = () => {
        try {
          if (!controller.signal.aborted) {
            controller.abort();
          }
        } catch {
          // no-op
        }
      };
      const onClientAborted = () => {
        abortUpstream();
      };
      const onClientClosed = () => {
        if (!reply.raw.writableEnded) {
          abortUpstream();
        }
      };
      const cleanupClientListeners = () => {
        request.raw.off?.('aborted', onClientAborted);
        reply.raw.off?.('close', onClientClosed);
      };
      request.raw.on('aborted', onClientAborted);
      reply.raw.on('close', onClientClosed);

      let upstream;
      try {
        const upstreamRequest = buildUpstreamRequest(payload, true);
        upstream = await fetch(upstreamRequest.url, {
          method: 'POST',
          headers: upstreamRequest.headers,
          body: JSON.stringify(upstreamRequest.body),
          signal: controller.signal,
        });
      } catch (error) {
        cleanupClientListeners();
        return reply.code(502).send({
          error: {
            message: (error as any)?.message || 'proxy request failed',
            type: 'server_error',
          },
        });
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        cleanupClientListeners();
        return reply.code(upstream.status).send(normalizeErrorPayload(text));
      }

      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');

      const reader = upstream.body?.getReader();
      if (!reader) {
        cleanupClientListeners();
        reply.raw.end();
        return;
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            reply.raw.write(Buffer.from(value));
          }
        }
      } catch (error) {
        if (!reply.raw.writableEnded) {
          const message = JSON.stringify({
            error: { message: (error as any)?.message || 'stream interrupted', type: 'stream_error' },
          });
          reply.raw.write(`event: error\ndata: ${message}\n\n`);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // no-op
        }
        cleanupClientListeners();
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
  );

  app.post<{ Body: TestChatRequestBody }>(
    '/api/test/chat/jobs',
    async (request, reply) => {
      const body = request.body || {};
      const payload = validatePayload(body, reply);
      if (!payload) return;

      const now = Date.now();
      const jobId = randomUUID();
      const job: TestChatJob = {
        id: jobId,
        status: 'pending',
        payload,
        controller: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + JOB_TTL_MS,
      };

      jobs.set(jobId, job);
      void runJob(jobId);

      return reply.code(202).send({
        jobId,
        status: job.status,
        createdAt: new Date(job.createdAt).toISOString(),
        expiresAt: new Date(job.expiresAt).toISOString(),
      });
    },
  );

  app.get<{ Params: { jobId: string } }>(
    '/api/test/chat/jobs/:jobId',
    async (request, reply) => {
      const job = jobs.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: { message: 'job not found', type: 'not_found' } });
      }

      return reply.send({
        jobId: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        createdAt: new Date(job.createdAt).toISOString(),
        updatedAt: new Date(job.updatedAt).toISOString(),
        expiresAt: new Date(job.expiresAt).toISOString(),
      });
    },
  );

  app.delete<{ Params: { jobId: string } }>(
    '/api/test/chat/jobs/:jobId',
    async (request, reply) => {
      const job = jobs.get(request.params.jobId);
      if (!job) {
        return reply.code(404).send({ error: { message: 'job not found', type: 'not_found' } });
      }

      if (job.status === 'pending' && job.controller) {
        try {
          job.controller.abort();
        } catch {
          // no-op
        }
      }

      jobs.delete(request.params.jobId);
      return reply.send({ success: true });
    },
  );
}
