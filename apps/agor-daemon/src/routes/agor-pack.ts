/**
 * HTTP routes for `.agorpack` teammate export/import ("Move to Agor Cloud").
 *
 * JSON routes are long authenticated routes (standard auth, MEMBER, tenant
 * identity and write gate, no request-long transaction; services open short
 * tenant units). The two byte-stream routes use the upload auth middleware
 * (browser JWT or, for the CLI, a personal API key). Executor data-plane
 * routes take a command token bound to one export/import, like
 * `/executor/uploads/:ref/content`.
 *
 *   GET  /agor-pack/preflight?branch_ids=…        counts, requirements, warnings
 *   POST /agor-pack/exports                       build a pack → { export_id, ref, … }
 *   GET  /agor-pack/downloads/:exportId/:ref      download it (creator only)
 *   POST /agor-pack/uploads                       upload a pack (raw body) → dry-run receipt
 *   GET  /agor-pack/imports/:importId             receipt, results, filesystem state
 *   POST /agor-pack/imports/:importId/apply       { teammates, board_id } → receipt (applying)
 *   POST /agor-pack/switch-over/:branchId         { undo } pause/resume the source copy
 *   POST /executor/agor-pack/fragments/:exportId  executor → daemon fragment upload
 *   GET  /executor/agor-pack/imports/:id/content  executor download of the staged pack
 */

import { Transform } from 'node:stream';
import { AgorPackFormatError, AgorPackSecretError, AgorPackWriter } from '@agor/core/agor-pack';
import { type AgorConfig, resolveMultiTenancyConfig } from '@agor/core/config';
import {
  AgorPackImportRepository,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { type Application, BadRequest } from '@agor/core/feathers';
import { generateId } from '@agor/core/ids';
import {
  AGOR_PACK,
  type AuthenticatedParams,
  agorPackApplyRequestSchema,
  agorPackExportRequestSchema,
  type DeepReadonly,
  type HookContext,
  hasMinimumRole,
  ROLES,
  type TenantID,
  type User,
  type UserID,
} from '@agor/core/types';
import type { NextFunction, Request, Response } from 'express';
import { matchesExecutorCommandRuntimeScope } from '../auth/executor-runtime-scope.js';
import { authenticateBearerHttpRequest } from '../register-routes.js';
import {
  agorPackCollectExecutorCommandId,
  agorPackMaterializeExecutorCommandId,
} from '../services/agor-pack-executor.js';
import {
  AgorPackExporter,
  type AgorPackServiceContext,
  agorPackBlob,
} from '../services/agor-pack-export.js';
import { AgorPackImporter, openStagedPack } from '../services/agor-pack-import.js';
import { switchOverTeammate } from '../services/agor-pack-switch-over.js';
import type { registerAuthenticatedRoute } from '../utils/authorization.js';
import { deferWithTenantContext } from '../utils/tenant-db-scope.js';
import { getBlobStagingStore } from '../utils/upload-staging.js';

type PackRequest = Request & { feathers?: AuthenticatedParams };
type RouteParams = AuthenticatedParams & { route?: Record<string, string> };

export interface AgorPackRouteContext {
  app: Application;
  db: TenantScopeAwareDatabase;
  config: DeepReadonly<AgorConfig>;
  agorVersion: string;
  /** The daemon's long authenticated route registrar. */
  registerLongAuthenticatedRoute: typeof registerAuthenticatedRoute;
  requireAuth: (context: HookContext) => Promise<HookContext>;
  /** Upload auth middleware (JWT or personal API key) for the byte-stream routes. */
  streamAuth: (req: PackRequest, res: Response, next: NextFunction) => unknown;
}

/** Pack format/secret refusals are the caller's input, not server faults. */
function packError(error: unknown): unknown {
  return error instanceof AgorPackFormatError || error instanceof AgorPackSecretError
    ? new BadRequest(error.message)
    : error;
}

/** Map errors on the raw routes to clean HTTP statuses without leaking internals. */
export function sendPackError(res: Response, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const mapped = packError(error);
  const status =
    typeof (mapped as { code?: unknown }).code === 'number'
      ? ((mapped as { code: number }).code as number)
      : typeof (mapped as { status?: unknown }).status === 'number'
        ? ((mapped as { status: number }).status as number)
        : 500;
  const message =
    status >= 500
      ? 'Pack operation failed'
      : mapped instanceof Error
        ? mapped.message
        : 'Bad request';
  if (status >= 500) console.error('[agor-pack]', error);
  res.status(status).json({ error: message });
}

export function registerAgorPackRoutes(ctx: AgorPackRouteContext): void {
  const { app, db, config, registerLongAuthenticatedRoute, requireAuth, streamAuth } = ctx;
  const multiTenancy = resolveMultiTenancyConfig(config as AgorConfig);
  const member = (action: string) => ({ role: ROLES.MEMBER, action });

  const serviceContext = (params: AuthenticatedParams): AgorPackServiceContext => ({
    app,
    db,
    config,
    tenantId: params.tenant?.tenant_id as TenantID,
    user: params.user as User,
    agorVersion: ctx.agorVersion,
  });
  const handle = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw packError(error);
    }
  };

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/preflight',
    {
      async find(params: RouteParams) {
        const raw = String((params.query as { branch_ids?: unknown })?.branch_ids ?? '');
        const branchIds = [...new Set(raw.split(',').filter(Boolean))];
        if (branchIds.length === 0 || branchIds.length > AGOR_PACK.maxTeammates) {
          throw new BadRequest('branch_ids is required');
        }
        return {
          teammates: await handle(() =>
            new AgorPackExporter(serviceContext(params)).preflight(branchIds)
          ),
        };
      },
    },
    { find: member('export teammates') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/exports',
    {
      async create(data: unknown, params: RouteParams) {
        const parsed = agorPackExportRequestSchema.safeParse(data);
        if (!parsed.success) {
          throw new BadRequest(`Invalid export request: ${parsed.error.issues[0]?.message ?? ''}`);
        }
        const exportId = generateId();
        const context = serviceContext(params);
        const writer = new AgorPackWriter();
        // The finished pack is staged so a failure anywhere surfaces as a
        // clean error instead of a truncated download.
        const staged = getBlobStagingStore().stage({
          owner: {
            tenantId: context.tenantId,
            kind: 'agor-pack',
            scopeId: exportId,
            createdBy: context.user.user_id as UserID,
          },
          name: `export${AGOR_PACK.extension}`,
          mimeType: AGOR_PACK.mimeType,
          body: writer.output,
        });
        let manifest: Awaited<ReturnType<AgorPackExporter['export']>>;
        try {
          manifest = await handle(() => new AgorPackExporter(context).export(parsed.data, writer));
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
        return {
          export_id: exportId,
          ref: metadata.ref,
          size: metadata.size,
          filename: `${slug}${manifest.teammates.length > 1 ? `-and-${manifest.teammates.length - 1}-more` : ''}${AGOR_PACK.extension}`,
          manifest,
        };
      },
    },
    { create: member('export teammates') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/imports',
    {
      async get(importId: string, params: RouteParams) {
        return new AgorPackImporter(serviceContext(params), params).get(importId);
      },
    },
    { get: member('import teammates') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/imports/:importId/apply',
    {
      async create(data: unknown, params: RouteParams) {
        const parsed = agorPackApplyRequestSchema.safeParse(data);
        if (!parsed.success) {
          throw new BadRequest(`Invalid apply request: ${parsed.error.issues[0]?.message ?? ''}`);
        }
        const importId = String(params.route?.importId ?? '');
        const importer = new AgorPackImporter(serviceContext(params), params);
        const { receipt, run } = await handle(() => importer.start(importId, parsed.data));
        // Rows, then files once each branch checkout is ready; the client
        // follows progress on the receipt.
        deferWithTenantContext(
          params,
          () => run({ files: true }),
          (error) => console.error('[agor-pack] apply failed', error)
        );
        return receipt;
      },
    },
    { create: member('import teammates') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/switch-over/:branchId',
    {
      async create(data: { undo?: unknown } | undefined, params: RouteParams) {
        return switchOverTeammate(
          serviceContext(params),
          params,
          String(params.route?.branchId ?? ''),
          data?.undo === true
        );
      },
    },
    { create: member('switch teammates over') },
    requireAuth
  );

  // biome-ignore lint/suspicious/noExplicitAny: Express route method not on FeathersJS Application type
  const express = app as any;

  /** The upload auth middleware authenticated the caller; packs are MEMBER+. */
  const caller = (req: PackRequest): AuthenticatedParams => {
    const params = req.feathers;
    if (!params?.user || !params.tenant?.tenant_id) {
      throw Object.assign(new Error('Authentication required'), { code: 401 });
    }
    if (!hasMinimumRole(params.user.role, ROLES.MEMBER)) {
      throw Object.assign(new Error('Members only'), { code: 403 });
    }
    return params;
  };

  express.get(
    '/agor-pack/downloads/:exportId/:ref',
    streamAuth,
    async (req: PackRequest & { params: { exportId: string; ref: string } }, res: Response) => {
      try {
        const params = caller(req);
        // Bound to the creator: nobody else's id opens it.
        const blob = agorPackBlob(serviceContext(params), req.params.exportId, req.params.ref);
        const store = getBlobStagingStore();
        const meta = await store.inspect(blob);
        const stream = await store.read(blob);
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

  express.post('/agor-pack/uploads', streamAuth, async (req: PackRequest, res: Response) => {
    try {
      const params = caller(req);
      const size = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
      if (!Number.isSafeInteger(size) || size <= 0) {
        throw Object.assign(new Error('Content-Length is required'), { code: 411 });
      }
      if (size > AGOR_PACK.maxBytes) {
        throw Object.assign(new Error('Pack exceeds the maximum size'), { code: 413 });
      }
      const result = await runWithTenantContext(params.tenant?.tenant_id as TenantID, () =>
        new AgorPackImporter(serviceContext(params), params).stage(req, size)
      );
      res.json(result);
    } catch (error) {
      req.resume();
      sendPackError(res, error);
    }
  });

  // Executor → daemon: the git/Claude-home fragment of one teammate export.
  express.post(
    '/executor/agor-pack/fragments/:exportId',
    async (req: PackRequest & { params: { exportId: string } }, res: Response) => {
      try {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const params = await authenticateBearerHttpRequest({
          authentication: app.service('authentication'),
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
        const staged = await getBlobStagingStore().stage({
          owner: {
            tenantId: params.tenant.tenant_id,
            kind: 'agor-pack',
            scopeId: req.params.exportId,
            createdBy: params.user.user_id as UserID,
          },
          name: 'fragment.zip',
          mimeType: AGOR_PACK.mimeType,
          body: limiter,
          sizeHint: size,
        });
        res.json({ ref: staged.ref });
      } catch (error) {
        sendPackError(res, error);
      }
    }
  );

  // Executor download of a staged pack for `branch.pack.materialize`.
  express.get(
    '/executor/agor-pack/imports/:importId/content',
    async (req: PackRequest & { params: { importId: string } }, res: Response) => {
      try {
        const header = req.headers.authorization;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const params = await authenticateBearerHttpRequest({
          authentication: app.service('authentication'),
          multiTenancy,
          headers: req.headers as Record<string, unknown>,
          token: header.slice(7),
        });
        const claims = params.authentication?.payload as Record<string, unknown> | undefined;
        const branchId = claims?.branch_id;
        const tenantId = params.tenant?.tenant_id;
        const key = String(req.query.key ?? '');
        const claim = String(req.query.claim ?? '');
        if (
          typeof branchId !== 'string' ||
          !tenantId ||
          !matchesExecutorCommandRuntimeScope(
            params,
            agorPackMaterializeExecutorCommandId(req.params.importId, key, claim),
            branchId
          )
        ) {
          res.status(403).json({ error: 'Pack download capability denied' });
          return;
        }
        const record = await runWithTenantDatabaseScope(db, tenantId, () =>
          new AgorPackImportRepository(db).findById(req.params.importId)
        );
        if (!record || record.owner_user_id !== params.user?.user_id) {
          res.status(404).json({ error: 'Import not found' });
          return;
        }
        // Only the attempt that currently holds the apply claim may fetch it.
        if (!claim || record.claim_token !== claim) {
          res.status(409).json({ error: 'This import attempt is no longer current' });
          return;
        }
        const { source } = await openStagedPack({ tenantId: tenantId as TenantID }, record);
        const stream = await source.readRange(0, source.size);
        res.setHeader('Content-Type', AGOR_PACK.mimeType);
        res.setHeader('Content-Length', String(source.size));
        res.setHeader('Cache-Control', 'private, no-store');
        stream.once('error', (error) => res.destroy(error as Error));
        res.once('close', () => stream.destroy());
        stream.pipe(res);
      } catch (error) {
        sendPackError(res, error);
      }
    }
  );
}
