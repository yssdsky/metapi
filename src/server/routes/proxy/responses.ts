import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { reportProxyAllFailed, reportTokenExpired } from '../../services/alertService.js';
import { isTokenExpiredError } from '../../services/alertRules.js';
import { estimateProxyCost } from '../../services/modelPricingService.js';
import { shouldRetryProxyRequest } from '../../services/proxyRetryPolicy.js';
import { resolveProxyUsageWithSelfLogFallback } from '../../services/proxyUsageFallbackService.js';
import { mergeProxyUsage, parseProxyUsage, pullSseDataEvents } from '../../services/proxyUsageParser.js';
import { normalizeUpstreamFinalResponse } from './chatFormats.js';
import {
  buildUpstreamEndpointRequest,
  isEndpointDowngradeError,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpoint.js';

const MAX_RETRIES = 2;

function withUpstreamPath(path: string, message: string): string {
  return `[upstream:${path}] ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0)
      .join('\n');
  }
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.input_text === 'string') return value.input_text;
    if (typeof value.output_text === 'string') return value.output_text;
    if (Array.isArray(value.content)) return normalizeText(value.content);
  }
  return '';
}

function convertResponsesBodyToOpenAiBody(
  body: Record<string, unknown>,
  modelName: string,
  stream: boolean,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  const input = body.input;

  if (typeof input === 'string') {
    const text = input.trim();
    if (text) messages.push({ role: 'user', content: text });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) continue;
      const role = typeof item.role === 'string' ? item.role : 'user';
      const text = normalizeText(item.content ?? item).trim();
      if (!text) continue;
      messages.push({ role: role === 'assistant' ? 'assistant' : (role === 'system' ? 'system' : 'user'), content: text });
    }
  } else if (isRecord(input)) {
    const text = normalizeText(input).trim();
    if (text) messages.push({ role: 'user', content: text });
  }

  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions) {
    messages.unshift({ role: 'system', content: instructions });
  }

  const payload: Record<string, unknown> = {
    model: modelName,
    stream,
    messages,
  };

  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    payload.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) {
    payload.top_p = body.top_p;
  }
  if (typeof body.max_output_tokens === 'number' && Number.isFinite(body.max_output_tokens)) {
    payload.max_tokens = body.max_output_tokens;
  }
  if (body.tools !== undefined) payload.tools = body.tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;

  return payload;
}

function toResponsesPayload(
  normalized: ReturnType<typeof normalizeUpstreamFinalResponse>,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number },
): Record<string, unknown> {
  const normalizedId = typeof normalized.id === 'string' && normalized.id.trim()
    ? normalized.id.trim()
    : `resp_${Date.now()}`;
  const responseId = normalizedId.startsWith('resp_') ? normalizedId : `resp_${normalizedId}`;
  const messageId = normalizedId.startsWith('msg_') ? normalizedId : `msg_${normalizedId}`;

  return {
    id: responseId,
    object: 'response',
    created: normalized.created,
    status: 'completed',
    model: normalized.model,
    output: [{
      id: messageId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{
        type: 'output_text',
        text: normalized.content || '',
      }],
    }],
    output_text: normalized.content || '',
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

export async function responsesProxyRoute(app: FastifyInstance) {
  app.post('/v1/responses', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as any;
    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: 'model is required', type: 'invalid_request_error' } });
    }

    const isStream = body.stream === true;
    const excludeChannelIds: number[] = [];
    let retryCount = 0;

    while (retryCount <= MAX_RETRIES) {
      let selected = retryCount === 0
        ? tokenRouter.selectChannel(requestedModel)
        : tokenRouter.selectNextChannel(requestedModel, excludeChannelIds);

      if (!selected && retryCount === 0) {
        await refreshModelsAndRebuildRoutes();
        selected = tokenRouter.selectChannel(requestedModel);
      }

      if (!selected) {
        await reportProxyAllFailed({
          model: requestedModel,
          reason: 'No available channels after retries',
        });
        return reply.code(503).send({
          error: { message: 'No available channels for this model', type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);

      const modelName = selected.actualModel || requestedModel;
      const openAiBody = convertResponsesBodyToOpenAiBody(body, modelName, isStream);
      const resolvedCandidates = await resolveUpstreamEndpointCandidates(
        {
          site: selected.site,
          account: selected.account,
        },
        modelName,
        'openai',
      );
      const endpointCandidates = resolvedCandidates
        .filter((endpoint) => endpoint !== 'responses');
      if (endpointCandidates.length === 0) {
        endpointCandidates.push('chat', 'messages');
      }

      const startTime = Date.now();

      try {
        let upstream: Awaited<ReturnType<typeof fetch>> | null = null;
        let successfulUpstreamPath: string | null = null;
        let finalStatus = 0;
        let finalErrText = 'unknown error';

        for (let endpointIndex = 0; endpointIndex < endpointCandidates.length; endpointIndex += 1) {
          const endpoint = endpointCandidates[endpointIndex] as UpstreamEndpoint;
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: isStream,
            tokenValue: selected.tokenValue,
            openaiBody: openAiBody,
          });
          const targetUrl = `${selected.site.url}${endpointRequest.path}`;

          const response = await fetch(targetUrl, {
            method: 'POST',
            headers: endpointRequest.headers,
            body: JSON.stringify(endpointRequest.body),
          });

          if (response.ok) {
            upstream = response;
            successfulUpstreamPath = endpointRequest.path;
            break;
          }

          const rawErrText = await response.text().catch(() => 'unknown error');
          const errText = withUpstreamPath(endpointRequest.path, rawErrText);
          const shouldDowngradeEndpoint = (
            endpointIndex < endpointCandidates.length - 1
            && isEndpointDowngradeError(response.status, rawErrText)
          );

          if (shouldDowngradeEndpoint) {
            logProxy(selected, requestedModel, 'failed', response.status, Date.now() - startTime, errText, retryCount);
            continue;
          }

          finalStatus = response.status;
          finalErrText = errText;
          break;
        }

        if (!upstream) {
          const status = finalStatus || 502;
          const errText = finalErrText || 'unknown error';
          tokenRouter.recordFailure(selected.channel.id);
          logProxy(selected, requestedModel, 'failed', status, Date.now() - startTime, errText, retryCount);

          if (isTokenExpiredError({ status, message: errText })) {
            await reportTokenExpired({
              accountId: selected.account.id,
              username: selected.account.username,
              siteName: selected.site.name,
              detail: `HTTP ${status}`,
            });
          }

          if (shouldRetryProxyRequest(status, errText) && retryCount < MAX_RETRIES) {
            retryCount += 1;
            continue;
          }

          await reportProxyAllFailed({
            model: requestedModel,
            reason: `upstream returned HTTP ${status}`,
          });
          return reply.code(status).send({ error: { message: errText, type: 'upstream_error' } });
        }

        if (isStream) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          const reader = upstream.body?.getReader();
          if (!reader) {
            reply.raw.end();
            return;
          }

          const decoder = new TextDecoder();
          let parsedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          let sseBuffer = '';
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              reply.raw.write(chunk);

              sseBuffer += chunk;
              const pulled = pullSseDataEvents(sseBuffer);
              sseBuffer = pulled.rest;
              for (const eventPayload of pulled.events) {
                try {
                  parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(JSON.parse(eventPayload)));
                } catch {}
              }
            }
            if (sseBuffer.trim().length > 0) {
              const pulled = pullSseDataEvents(`${sseBuffer}\n\n`);
              for (const eventPayload of pulled.events) {
                try {
                  parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(JSON.parse(eventPayload)));
                } catch {}
              }
            }
          } finally {
            reader.releaseLock();
            reply.raw.end();
          }

          const latency = Date.now() - startTime;
          const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
            site: selected.site,
            account: selected.account,
            tokenValue: selected.tokenValue,
            tokenName: selected.tokenName,
            modelName: selected.actualModel || requestedModel,
            requestStartedAtMs: startTime,
            requestEndedAtMs: startTime + latency,
            localLatencyMs: latency,
            usage: {
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
            },
          });
          let estimatedCost = await estimateProxyCost({
            site: selected.site,
            account: selected.account,
            modelName: selected.actualModel || requestedModel,
            promptTokens: resolvedUsage.promptTokens,
            completionTokens: resolvedUsage.completionTokens,
            totalTokens: resolvedUsage.totalTokens,
          });
          if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
            estimatedCost = resolvedUsage.estimatedCostFromQuota;
          }
          tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
          logProxy(
            selected, requestedModel, 'success', 200, latency, null, retryCount,
            resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost,
            successfulUpstreamPath,
          );
          return;
        }

        const rawText = await upstream.text();
        let upstreamData: unknown = rawText;
        try {
          upstreamData = JSON.parse(rawText);
        } catch {
          upstreamData = rawText;
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const normalized = normalizeUpstreamFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = toResponsesPayload(normalized, parsedUsage);
        const resolvedUsage = await resolveProxyUsageWithSelfLogFallback({
          site: selected.site,
          account: selected.account,
          tokenValue: selected.tokenValue,
          tokenName: selected.tokenName,
          modelName: selected.actualModel || requestedModel,
          requestStartedAtMs: startTime,
          requestEndedAtMs: startTime + latency,
          localLatencyMs: latency,
          usage: {
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
          },
        });
        let estimatedCost = await estimateProxyCost({
          site: selected.site,
          account: selected.account,
          modelName: selected.actualModel || requestedModel,
          promptTokens: resolvedUsage.promptTokens,
          completionTokens: resolvedUsage.completionTokens,
          totalTokens: resolvedUsage.totalTokens,
        });
        if (resolvedUsage.estimatedCostFromQuota > 0 && (resolvedUsage.recoveredFromSelfLog || estimatedCost <= 0)) {
          estimatedCost = resolvedUsage.estimatedCostFromQuota;
        }

        tokenRouter.recordSuccess(selected.channel.id, latency, estimatedCost);
        logProxy(
          selected, requestedModel, 'success', 200, latency, null, retryCount,
          resolvedUsage.promptTokens, resolvedUsage.completionTokens, resolvedUsage.totalTokens, estimatedCost,
          successfulUpstreamPath,
        );
        return reply.send(downstreamData);
      } catch (err: any) {
        tokenRouter.recordFailure(selected.channel.id);
        logProxy(selected, requestedModel, 'failed', 0, Date.now() - startTime, err.message, retryCount);
        if (retryCount < MAX_RETRIES) {
          retryCount += 1;
          continue;
        }
        await reportProxyAllFailed({
          model: requestedModel,
          reason: err.message || 'network failure',
        });
        return reply.code(502).send({
          error: { message: `Upstream error: ${err.message}`, type: 'upstream_error' },
        });
      }
    }
  });
}

function logProxy(
  selected: any,
  modelRequested: string,
  status: string,
  httpStatus: number,
  latencyMs: number,
  errorMessage: string | null,
  retryCount: number,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  estimatedCost = 0,
  upstreamPath: string | null = null,
) {
  try {
    const normalizedErrorMessage = errorMessage
      || (upstreamPath ? `[upstream:${upstreamPath}]` : null);
    db.insert(schema.proxyLogs).values({
      routeId: selected.channel.routeId,
      channelId: selected.channel.id,
      accountId: selected.account.id,
      modelRequested,
      modelActual: selected.actualModel,
      status,
      httpStatus,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCost,
      errorMessage: normalizedErrorMessage,
      retryCount,
    }).run();
  } catch {}
}
