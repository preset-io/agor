/**
 * HTTP routes for `.agorpack` teammate export/import ("Move to Agor Cloud").
 *
 * Packs are binary and can be large, so every route is a raw Express route
 * (no Feathers service, no request-long transaction). Each handler resolves
 * the caller (browser JWT or personal API key) and tenant itself, requires
 * MEMBER, and opens short tenant database units for every read/write.
 *
 *   GET  /agor-pack/preflight?branch_ids=…        counts, requirements, warnings
 *   POST /agor-pack/exports                       build a pack → { export_id, ref, … }
 *   GET  /agor-pack/exports/:exportId/:ref        download it (creator only)
 *   POST /executor/agor-pack/fragments/:exportId  executor → daemon fragment upload
 */

import { Transform } from 'node:stream';
import { AgorPackFormatError, AgorPackSecretError, AgorPackWriter } from '@agor/core/agor-pack';
import {
  type AgorConfig,
  isMissingTenantContextError,
  resolveMultiTenancyConfig,
  resolveTenantContext,
} from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { type Application, BadRequest, NotAuthenticated } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  AGOR_PACK,
  type AuthenticatedParams,
  agorPackExportRequestSchema,
  type DeepReadonly,
  hasMinimumRole,
  PERSONAL_API_KEY_PREFIX,
  ROLES,
  type TenantID,
  type UploadRef,
  type User,
  type UUID,
} from '@agor/core/types';
import type { NextFunction, Request, Response } from 'express';
import { createApiKeyHostTenantResolver } from '../auth/api-key-host-tenant.js';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { authenticateBearerHttpRequest } from '../register-routes.js';
import { agorPackCollectExecutorCommandId } from '../services/agor-pack-executor.js';
import { AgorPackExporter, type AgorPackServiceContext } from '../services/agor-pack-export.js';
import { getAgorPackStagingStore } from '../utils/upload-staging.js';

type PackRequest = Request & { feathers?: AuthenticatedParams };

interface PackAuthenticationService {
  create(
    data: { strategy: 'jwt'; accessToken: string },
    params: AuthenticatedParams
  ): Promise<{ user?: User; authentication?: { payload?: unknown } }>;
  authenticate(
    data: { strategy: 'api-key'; apiKey: string },
    params: AuthenticatedParams,
    ...strategies: string[]
  ): Promise<{ user?: User; authentication?: { payload?: unknown } }>;
}

export interface AgorPackRouteContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: DeepReadonly<AgorConfig>;
  agorVersion: string;
}

/** Map pack errors to clean HTTP statuses without leaking internals. */
export function sendPackError(res: Response, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status =
    error instanceof AgorPackFormatError || error instanceof AgorPackSecretError
      ? 400
      : typeof (error as { code?: unknown }).code === 'number'
        ? ((error as { code: number }).code as number)
        : typeof (error as { status?: unknown }).status === 'number'
          ? ((error as { status: number }).status as number)
          : 500;
  const message =
    status >= 500
      ? 'Pack operation failed'
      : error instanceof Error
        ? error.message
        : 'Bad request';
  if (status >= 500) console.error('[agor-pack]', error);
  res.status(status).json({ error: message });
}

export function registerAgorPackRoutes(ctx: AgorPackRouteContext): void {
  const { app, db, config } = ctx;
  const multiTenancy = resolveMultiTenancyConfig(config as AgorConfig);
  const resolveApiKeyHostTenant = createApiKeyHostTenantResolver({
    db,
    config: config as AgorConfig,
  });
  const authentication = () =>
    app.service('authentication') as unknown as PackAuthenticationService;

  /**
   * Browser JWT or personal API key (the CLI). An API key carries no signed
   * tenant, so the tenant comes from static config or the trusted Host,
   * exactly as the Feathers REST transport resolves it.
   */
  const authenticate = async (req: PackRequest): Promise<AuthenticatedParams> => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new NotAuthenticated('Authentication required');
    let params: AuthenticatedParams;
    if (token.startsWith(PERSONAL_API_KEY_PREFIX)) {
      const headers = req.headers as Record<string, unknown>;
      let tenant: AuthenticatedParams['tenant'];
      try {
        tenant = resolveTenantContext(multiTenancy, { params: { headers }, headers });
      } catch (error) {
        if (!isMissingTenantContextError(error) || !resolveApiKeyHostTenant) throw error;
        tenant = await resolveApiKeyHostTenant(headers);
      }
      const base: AuthenticatedParams = { headers, tenant, provider: 'rest' };
      const result = await authentication().authenticate(
        { strategy: 'api-key', apiKey: token },
        base,
        'api-key'
      );
      params = { ...base, user: result.user, authentication: result.authentication as never };
    } else {
      params = await authenticateBearerHttpRequest({
        authentication: authentication(),
        multiTenancy,
        headers: req.headers as Record<string, unknown>,
        token,
      });
    }
    if (!params.user || !params.tenant?.tenant_id) {
      throw new NotAuthenticated('Authentication required');
    }
    if (!hasMinimumRole(params.user.role, ROLES.MEMBER)) {
      throw Object.assign(new Error('Members only'), { code: 403 });
    }
    return params;
  };

  const serviceContext = (params: AuthenticatedParams): AgorPackServiceContext => ({
    app,
    db,
    config,
    tenantId: params.tenant?.tenant_id as TenantID,
    user: params.user as User,
    agorVersion: ctx.agorVersion,
  });

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  const express = app as any;

  express.get('/agor-pack/preflight', async (req: PackRequest, res: Response) => {
    try {
      const params = await authenticate(req);
      const raw = String(req.query.branch_ids ?? '');
      const branchIds = [...new Set(raw.split(',').filter(Boolean))];
      if (branchIds.length === 0 || branchIds.length > AGOR_PACK.maxTeammates) {
        throw new BadRequest('branch_ids is required');
      }
      const teammates = await new AgorPackExporter(serviceContext(params)).preflight(branchIds);
      res.json({ teammates });
    } catch (error) {
      sendPackError(res, error);
    }
  });

  express.post('/agor-pack/exports', async (req: PackRequest, res: Response) => {
    try {
      const params = await authenticate(req);
      const parsed = agorPackExportRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest(`Invalid export request: ${parsed.error.issues[0]?.message ?? ''}`);
      }
      const exportId = generateId();
      const context = serviceContext(params);
      const writer = new AgorPackWriter();
      const store = getAgorPackStagingStore();
      // The finished pack is staged (bytes only, no uploads row) so a failure
      // anywhere surfaces as a clean error instead of a truncated download.
      const staged = store.stage({
        owner: {
          tenantId: context.tenantId,
          sessionId: exportId as UUID,
          branchId: context.user.user_id as UUID,
          createdBy: context.user.user_id,
        },
        name: `export${AGOR_PACK.extension}`,
        mimeType: AGOR_PACK.mimeType,
        provenance: 'import',
        body: writer.output,
      });
      let manifest: Awaited<ReturnType<AgorPackExporter['export']>>;
      try {
        manifest = await new AgorPackExporter(context).export(parsed.data, writer);
      } catch (error) {
        writer.abort(error instanceof Error ? error : new Error(String(error)));
        await staged.catch(() => undefined);
        throw error;
      }
      const metadata = await staged;
      const first = manifest.teammates[0]?.display_name ?? 'teammates';
      const slug =
        first
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'teammates';
      res.json({
        export_id: exportId,
        ref: metadata.ref,
        size: metadata.size,
        filename: `${slug}${manifest.teammates.length > 1 ? `-and-${manifest.teammates.length - 1}-more` : ''}${AGOR_PACK.extension}`,
        manifest,
      });
    } catch (error) {
      sendPackError(res, error);
    }
  });

  express.get(
    '/agor-pack/exports/:exportId/:ref',
    async (req: PackRequest & { params: { exportId: string; ref: string } }, res: Response) => {
      try {
        const params = await authenticate(req);
        const owner = {
          tenantId: params.tenant?.tenant_id as TenantID,
          sessionId: req.params.exportId as UUID,
          // Bound to the creator: nobody else's id opens it.
          branchId: params.user?.user_id as UUID,
          ref: req.params.ref as UploadRef,
        };
        const store = getAgorPackStagingStore();
        const meta = await store.inspect(owner);
        const stream = await store.read(owner);
        const filename = String(req.query.filename ?? `teammates${AGOR_PACK.extension}`).replace(
          /[^A-Za-z0-9._-]/g,
          '_'
        );
        res.setHeader('Content-Type', AGOR_PACK.mimeType);
        res.setHeader('Content-Length', String(meta.size));
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        stream.once('error', (error) => res.destroy(error as Error));
        res.once('close', () =>
          (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
        );
        stream.pipe(res);
      } catch (error) {
        sendPackError(res, error);
      }
    }
  );

  // Executor → daemon: the git/Claude-home fragment of one teammate export.
  express.post(
    '/executor/agor-pack/fragments/:exportId',
    async (
      req: PackRequest & { params: { exportId: string } },
      res: Response,
      _next: NextFunction
    ) => {
      try {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const params = await authenticateBearerHttpRequest({
          authentication: authentication(),
          multiTenancy,
          headers: req.headers as Record<string, unknown>,
          token: header.slice(7),
        });
        const claims = params.authentication?.payload as Record<string, unknown> | undefined;
        const branchId = claims?.branch_id;
        const size = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
        if (
          typeof branchId !== 'string' ||
          !params.tenant?.tenant_id ||
          !params.user?.user_id ||
          !matchesExecutorCommandRuntimeScope(
            params,
            agorPackCollectExecutorCommandId(req.params.exportId),
            branchId
          ) ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > AGOR_PACK.maxBytes
        ) {
          res.status(403).json({ error: 'Pack fragment capability denied' });
          return;
        }
        let received = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.byteLength;
            callback(
              received > size ? new Error('Fragment exceeds its declared size') : null,
              chunk
            );
          },
          flush(callback) {
            callback(received === size ? undefined : new Error('Fragment size mismatch'));
          },
        });
        req.pipe(limiter);
        const staged = await getAgorPackStagingStore().stage({
          owner: {
            tenantId: params.tenant.tenant_id,
            sessionId: req.params.exportId as UUID,
            branchId: branchId as UUID,
            createdBy: params.user.user_id as UUID,
          },
          name: 'fragment.zip',
          mimeType: AGOR_PACK.mimeType,
          provenance: 'import',
          body: limiter,
          sizeHint: size,
        });
        res.json({ ref: staged.ref });
      } catch (error) {
        sendPackError(res, error);
      }
    }
  );
}
