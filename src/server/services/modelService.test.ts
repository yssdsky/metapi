import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');

describe('rebuildTokenRoutesFromAvailability', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let rebuildTokenRoutesFromAvailability: ModelServiceModule['rebuildTokenRoutesFromAvailability'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    rebuildTokenRoutesFromAvailability = modelService.rebuildTokenRoutesFromAvailability;
  });

  beforeEach(() => {
    db.delete(schema.routeChannels).run();
    db.delete(schema.tokenRoutes).run();
    db.delete(schema.tokenModelAvailability).run();
    db.delete(schema.modelAvailability).run();
    db.delete(schema.accountTokens).run();
    db.delete(schema.accounts).run();
    db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('removes stale exact routes and keeps wildcard routes on rebuild', () => {
    const site = db.insert(schema.sites).values({
      name: 'site-1',
      url: 'https://site-1.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-1',
      accessToken: 'access-1',
      status: 'active',
    }).returning().get();

    const token = db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-test',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).returning().get();

    db.insert(schema.tokenModelAvailability).values({
      tokenId: token.id,
      modelName: 'latest-model',
      available: true,
    }).run();

    const staleRoute = db.insert(schema.tokenRoutes).values({
      modelPattern: 'old-model',
      enabled: true,
    }).returning().get();

    db.insert(schema.routeChannels).values({
      routeId: staleRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const wildcardRoute = db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-*',
      enabled: true,
    }).returning().get();

    db.insert(schema.routeChannels).values({
      routeId: wildcardRoute.id,
      accountId: account.id,
      tokenId: token.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const rebuild = rebuildTokenRoutesFromAvailability();

    expect(rebuild.models).toBe(1);
    expect(rebuild.removedRoutes).toBe(1);

    const oldRoute = db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, staleRoute.id)).get();
    expect(oldRoute).toBeUndefined();

    const oldChannels = db.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, staleRoute.id)).all();
    expect(oldChannels).toHaveLength(0);

    const latestRoute = db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'latest-model')).get();
    expect(latestRoute).toBeDefined();
    const latestChannels = db.select().from(schema.routeChannels)
      .where(and(eq(schema.routeChannels.routeId, latestRoute!.id), eq(schema.routeChannels.tokenId, token.id)))
      .all();
    expect(latestChannels.length).toBeGreaterThan(0);

    const wildcardRouteAfter = db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, wildcardRoute.id)).get();
    expect(wildcardRouteAfter).toBeDefined();
  });
});
