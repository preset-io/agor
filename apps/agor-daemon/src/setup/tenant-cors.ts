import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  type ResolvedCors,
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import {
  runWithTenantDatabaseScope,
  TenantCorsSettingsRepository,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { normalizeTenantCorsOrigin } from '@agor/core/types';
import cors, { type CorsOptionsDelegate } from 'cors';
import type { NextFunction, Request, Response } from 'express';
import type { CorsConfigResult } from './cors.js';
import { isSandpackOrigin } from './cors.js';

interface CachedTenantOrigins {
  origins: ReadonlySet<string>;
  expiresAt: number;
}

const MAX_TENANT_CORS_CACHE_ENTRIES = 1_000;

/**
 * Small tenant-keyed read-through cache. Mutations on this daemon invalidate
 * immediately; the short TTL bounds propagation when multiple daemon
 * instances share PostgreSQL.
 */
export class TenantCorsPolicyStore {
  private readonly cache = new Map<string, CachedTenantOrigins>();

  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly ttlMs = 5_000
  ) {}

  async getOrigins(tenantId: string): Promise<ReadonlySet<string>> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.origins;
    if (cached) this.cache.delete(tenantId);

    const settings = await runWithTenantDatabaseScope(this.db, tenantId, async (tenantDb) =>
      new TenantCorsSettingsRepository(tenantDb).get()
    );
    const origins = new Set(settings.origins);
    if (this.cache.size >= MAX_TENANT_CORS_CACHE_ENTRIES) {
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      if (this.cache.size >= MAX_TENANT_CORS_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) this.cache.delete(oldestKey);
      }
    }
    this.cache.set(tenantId, { origins, expiresAt: now + this.ttlMs });
    return origins;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

function headerRecord(headers: IncomingHttpHeaders): Record<string, unknown> {
  return headers as Record<string, unknown>;
}

function targetOriginForExpressRequest(req: Request): string | undefined {
  const host = req.get('host');
  if (!host) return undefined;
  try {
    return normalizeTenantCorsOrigin(`${req.protocol}://${host}`);
  } catch {
    return undefined;
  }
}

function targetOriginForIncomingMessage(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  if (!host) return undefined;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protocol =
    typeof forwardedProto === 'string' &&
    !forwardedProto.includes(',') &&
    (forwardedProto === 'http' || forwardedProto === 'https')
      ? forwardedProto
      : (req.socket as { encrypted?: boolean }).encrypted
        ? 'https'
        : 'http';
  try {
    return normalizeTenantCorsOrigin(`${protocol}://${host}`);
  } catch {
    return undefined;
  }
}

export interface TenantCorsPolicyEngineOptions {
  resolved: ResolvedCors;
  base: CorsConfigResult;
  multiTenancy: ResolvedMultiTenancyConfig;
  getStore: () => TenantCorsPolicyStore | undefined;
}

/**
 * One origin-decision engine shared by HTTP and Socket.IO admission.
 *
 * The target tenant is resolved from static configuration or the trusted
 * pre-auth routing header. Authentication claims are deliberately not used:
 * browser preflights and anonymous Socket.IO handshakes do not carry them.
 */
export class TenantCorsPolicyEngine {
  constructor(private readonly options: TenantCorsPolicyEngineOptions) {}

  get enabled(): boolean {
    return this.options.resolved.tenantOriginsEnabled;
  }

  get routingReady(): boolean {
    return (
      this.options.multiTenancy.mode === 'static' ||
      Boolean(this.options.multiTenancy.trusted_header)
    );
  }

  private resolvePreAuthTenant(headers: Record<string, unknown>): string | undefined {
    try {
      return resolveTenantContext(this.options.multiTenancy, { headers }).tenant_id;
    } catch (error) {
      if (error instanceof TenantResolutionError) return undefined;
      throw error;
    }
  }

  async isOriginAllowed(
    origin: string | undefined,
    headers: Record<string, unknown>,
    targetOrigin?: string
  ): Promise<boolean> {
    if (!origin) return true;
    if (this.options.base.isCorsAllowedOrigin(origin)) return true;

    let normalized: string;
    try {
      normalized = normalizeTenantCorsOrigin(origin);
    } catch {
      return false;
    }

    if (targetOrigin && normalized === targetOrigin) return true;
    if (!this.enabled || !this.routingReady) return false;

    const tenantId = this.resolvePreAuthTenant(headers);
    const store = this.options.getStore();
    if (!tenantId || !store) return false;

    try {
      return (await store.getOrigins(tenantId)).has(normalized);
    } catch (error) {
      // Fail closed for the tenant augmentation while leaving operator origins
      // usable. Do not turn a transient DB failure into a global allow.
      console.error(
        `CORS tenant policy lookup failed for tenant ${tenantId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  async isExpressRequestAllowed(req: Request): Promise<boolean> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    return this.isOriginAllowed(
      origin,
      headerRecord(req.headers),
      targetOriginForExpressRequest(req)
    );
  }

  async isIncomingMessageAllowed(req: IncomingMessage): Promise<boolean> {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    return this.isOriginAllowed(
      origin,
      headerRecord(req.headers),
      targetOriginForIncomingMessage(req)
    );
  }
}

export function createTenantAwareCorsMiddleware(
  engine: TenantCorsPolicyEngine,
  base: CorsConfigResult,
  resolved: ResolvedCors
): (req: Request, res: Response, next: NextFunction) => void {
  const reflectedWithCredentials = cors({
    origin: true,
    credentials: base.credentialsAllowed,
    ...base.extraOptions,
  });
  const reflectedWithoutCredentials = cors({
    origin: true,
    credentials: false,
    ...base.extraOptions,
  });
  const wildcard = cors({
    origin: '*',
    credentials: false,
    ...base.extraOptions,
  });

  return (req, res, next) => {
    void engine
      .isExpressRequestAllowed(req)
      .then((allowed) => {
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        if (!allowed) {
          if (origin) res.vary('Origin');
          res.status(403).type('text/plain').send('Not allowed by CORS');
          return;
        }

        if (
          origin &&
          req.headers['access-control-request-private-network'] === 'true' &&
          base.isAllowedOrigin(origin)
        ) {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }

        if (resolved.mode === 'wildcard') {
          wildcard(req, res, next);
          return;
        }
        if (origin && isSandpackOrigin(origin)) {
          reflectedWithoutCredentials(req, res, next);
          return;
        }
        reflectedWithCredentials(req, res, next);
      })
      .catch(next);
  };
}

/**
 * Engine.IO accepts the full cors options-delegate form, so preflight can use
 * the same trusted tenant-routing context as normal HTTP instead of reflecting
 * a global union of tenant origins.
 */
export function createTenantAwareSocketCorsOptions(
  engine: TenantCorsPolicyEngine,
  base: CorsConfigResult,
  resolved: ResolvedCors
): CorsOptionsDelegate<IncomingMessage> {
  return (request, callback) => {
    void engine
      .isIncomingMessageAllowed(request)
      .then((allowed) => {
        if (!allowed) {
          callback(new Error('Not allowed by CORS'));
          return;
        }
        const origin =
          typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
        callback(null, {
          origin: resolved.mode === 'wildcard' ? '*' : true,
          credentials: base.credentialsAllowed && !(origin && isSandpackOrigin(origin)),
          ...base.extraOptions,
        });
      })
      .catch((error) =>
        callback(error instanceof Error ? error : new Error('CORS policy lookup failed'))
      );
  };
}
