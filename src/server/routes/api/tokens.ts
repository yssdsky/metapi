import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { rebuildTokenRoutesFromAvailability, refreshModelsAndRebuildRoutes } from '../../services/modelService.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';

function isExactModelPattern(modelPattern: string): boolean {
  return !/[\*\?\[]/.test(modelPattern);
}

function getDefaultTokenId(accountId: number): number | null {
  const token = db.select().from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true), eq(schema.accountTokens.isDefault, true)))
    .get();
  return token?.id ?? null;
}

function tokenSupportsModel(tokenId: number, modelName: string): boolean {
  const row = db.select().from(schema.tokenModelAvailability)
    .where(
      and(
        eq(schema.tokenModelAvailability.tokenId, tokenId),
        eq(schema.tokenModelAvailability.modelName, modelName),
        eq(schema.tokenModelAvailability.available, true),
      ),
    )
    .get();
  return !!row;
}

function checkTokenBelongsToAccount(tokenId: number, accountId: number): boolean {
  const row = db.select().from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.id, tokenId), eq(schema.accountTokens.accountId, accountId)))
    .get();
  return !!row;
}

type BatchChannelPriorityUpdate = {
  id: number;
  priority: number;
};

type BatchRouteDecisionModels = {
  models: string[];
};

function parseBatchChannelUpdates(input: unknown): { ok: true; updates: BatchChannelPriorityUpdate[] } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const updates = (input as { updates?: unknown }).updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, message: 'updates 必须是非空数组' };
  }

  const normalized: BatchChannelPriorityUpdate[] = [];
  for (let index = 0; index < updates.length; index += 1) {
    const item = updates[index];
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `updates[${index}] 必须是对象` };
    }

    const { id, priority } = item as { id?: unknown; priority?: unknown };
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return { ok: false, message: `updates[${index}].id 必须是有限数字` };
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return { ok: false, message: `updates[${index}].priority 必须是有限数字` };
    }

    const normalizedId = Math.trunc(id);
    if (normalizedId <= 0) {
      return { ok: false, message: `updates[${index}].id 必须大于 0` };
    }

    normalized.push({
      id: normalizedId,
      priority: Math.max(0, Math.trunc(priority)),
    });
  }

  return { ok: true, updates: normalized };
}

function parseBatchRouteDecisionModels(input: unknown): { ok: true; models: string[] } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const models = (input as BatchRouteDecisionModels).models;
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, message: 'models 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || dedupe.has(trimmed)) continue;
    dedupe.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'models 中没有有效模型名称' };
  }

  return { ok: true, models: normalized };
}

export async function tokensRoutes(app: FastifyInstance) {
  // List all routes
  app.get('/api/routes', async () => {
    const routes = db.select().from(schema.tokenRoutes).all();
    if (routes.length === 0) return [];

    const routeIds = routes.map((route) => route.id);
    const channelRows = db.select().from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
      .where(inArray(schema.routeChannels.routeId, routeIds))
      .all();

    const channelsByRoute = new Map<number, any[]>();

    for (const row of channelRows) {
      const routeId = row.route_channels.routeId;
      if (!channelsByRoute.has(routeId)) channelsByRoute.set(routeId, []);
      channelsByRoute.get(routeId)!.push({
        ...row.route_channels,
        account: row.accounts,
        site: row.sites,
        token: row.account_tokens
          ? {
            id: row.account_tokens.id,
            name: row.account_tokens.name,
            accountId: row.account_tokens.accountId,
            enabled: row.account_tokens.enabled,
            isDefault: row.account_tokens.isDefault,
          }
          : null,
      });
    }

    return routes.map((route) => ({
      ...route,
      channels: channelsByRoute.get(route.id) || [],
    }));
  });

  app.get<{ Querystring: { model?: string } }>('/api/routes/decision', async (request, reply) => {
    const model = (request.query.model || '').trim();
    if (!model) {
      return reply.code(400).send({ success: false, message: 'model 不能为空' });
    }

    const decision = tokenRouter.explainSelection(model);
    return { success: true, decision };
  });

  app.post<{ Body: BatchRouteDecisionModels }>('/api/routes/decision/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, ReturnType<typeof tokenRouter.explainSelection>> = {};
    for (const model of parsed.models) {
      decisions[model] = tokenRouter.explainSelection(model);
    }

    return { success: true, decisions };
  });

  // Create a route
  app.post<{ Body: { modelPattern: string; modelMapping?: string; enabled?: boolean } }>('/api/routes', async (request) => {
    const body = request.body;
    return db.insert(schema.tokenRoutes).values({
      modelPattern: body.modelPattern,
      modelMapping: body.modelMapping,
      enabled: body.enabled ?? true,
    }).returning().get();
  });

  // Update a route
  app.put<{ Params: { id: string }; Body: any }>('/api/routes/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    const body = request.body as Record<string, unknown>;
    const updates: Record<string, unknown> = {};

    if (body.modelPattern !== undefined) updates.modelPattern = body.modelPattern;
    if (body.modelMapping !== undefined) updates.modelMapping = body.modelMapping;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    updates.updatedAt = new Date().toISOString();

    db.update(schema.tokenRoutes).set(updates).where(eq(schema.tokenRoutes.id, id)).run();
    return db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).get();
  });

  // Delete a route
  app.delete<{ Params: { id: string } }>('/api/routes/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).run();
    return { success: true };
  });

  // Add a channel to a route
  app.post<{ Params: { id: string }; Body: { accountId: number; tokenId?: number; priority?: number; weight?: number } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    const effectiveTokenId = body.tokenId ?? getDefaultTokenId(body.accountId);

    if (body.tokenId && !checkTokenBelongsToAccount(body.tokenId, body.accountId)) {
      return reply.code(400).send({ success: false, message: '令牌不存在或不属于当前账号' });
    }

    if (isExactModelPattern(route.modelPattern) && effectiveTokenId && !tokenSupportsModel(effectiveTokenId, route.modelPattern)) {
      return reply.code(400).send({ success: false, message: '该令牌不支持当前模型' });
    }

    return db.insert(schema.routeChannels).values({
      routeId,
      accountId: body.accountId,
      tokenId: body.tokenId,
      priority: body.priority ?? 0,
      weight: body.weight ?? 10,
    }).returning().get();
  });

  // Batch update channel priorities
  app.put<{ Body: { updates: Array<{ id: number; priority: number }> } }>('/api/channels/batch', async (request, reply) => {
    const parsed = parseBatchChannelUpdates(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const channelIds = Array.from(new Set(parsed.updates.map((update) => update.id)));
    const existingChannels = db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, channelIds))
      .all();
    if (existingChannels.length !== channelIds.length) {
      const existingIds = new Set(existingChannels.map((channel) => channel.id));
      const missingId = channelIds.find((id) => !existingIds.has(id));
      return reply.code(404).send({ success: false, message: `通道不存在: ${missingId}` });
    }

    for (const update of parsed.updates) {
      db.update(schema.routeChannels).set({
        priority: update.priority,
        manualOverride: true,
      }).where(eq(schema.routeChannels.id, update.id)).run();
    }

    const updatedChannels = db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, channelIds))
      .all();
    return { success: true, channels: updatedChannels };
  });

  // Update a channel
  app.put<{ Params: { channelId: string }; Body: any }>('/api/channels/:channelId', async (request, reply) => {
    const channelId = parseInt(request.params.channelId, 10);
    const body = request.body as Record<string, unknown>;

    const channel = db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    if (!channel) {
      return reply.code(404).send({ success: false, message: '通道不存在' });
    }

    const route = db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, channel.routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    if (body.tokenId !== undefined && body.tokenId !== null) {
      const tokenId = Number(body.tokenId);
      if (!Number.isFinite(tokenId) || !checkTokenBelongsToAccount(tokenId, channel.accountId)) {
        return reply.code(400).send({ success: false, message: '令牌不存在或不属于通道账号' });
      }
    }

    const nextTokenId = body.tokenId === undefined
      ? (channel.tokenId ?? getDefaultTokenId(channel.accountId))
      : (body.tokenId === null ? getDefaultTokenId(channel.accountId) : Number(body.tokenId));

    if (isExactModelPattern(route.modelPattern) && nextTokenId && !tokenSupportsModel(nextTokenId, route.modelPattern)) {
      return reply.code(400).send({ success: false, message: '该令牌不支持当前模型' });
    }

    const updates: Record<string, unknown> = { manualOverride: true };
    for (const key of ['priority', 'weight', 'enabled', 'tokenId']) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    db.update(schema.routeChannels).set(updates).where(eq(schema.routeChannels.id, channelId)).run();
    return db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
  });

  // Delete a channel
  app.delete<{ Params: { channelId: string } }>('/api/channels/:channelId', async (request) => {
    const channelId = parseInt(request.params.channelId, 10);
    db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).run();
    return { success: true };
  });

  // Rebuild routes/channels from model availability.
  app.post<{ Body?: { refreshModels?: boolean; wait?: boolean } }>('/api/routes/rebuild', async (request, reply) => {
    const body = (request.body || {}) as { refreshModels?: boolean };
    if (body.refreshModels === false) {
      const rebuild = rebuildTokenRoutesFromAvailability();
      return { success: true, rebuild };
    }

    if ((request.body as { wait?: boolean } | undefined)?.wait) {
      const result = await refreshModelsAndRebuildRoutes();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'route',
        title: '刷新模型并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '刷新模型并重建路由已完成';
          return `刷新模型并重建路由完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `刷新模型并重建路由失败：${currentTask.error || 'unknown error'}`,
      },
      async () => refreshModelsAndRebuildRoutes(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '路由重建任务执行中，请稍后查看程序日志'
        : '已开始路由重建，请稍后查看程序日志',
    });
  });
}

