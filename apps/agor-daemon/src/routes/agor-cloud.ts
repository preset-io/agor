/**
 * Self-hosted "Sign in to Agor Cloud" and "Move to Agor Cloud" (Settings →
 * Agor Cloud, and the teammate menu). Long authenticated routes, MEMBER, each
 * caller only ever reads or changes their own link and moves.
 *
 *   GET    /agor-pack/cloud/link                  { console_url, link } (no tokens)
 *   DELETE /agor-pack/cloud/link                  forget the link
 *   POST   /agor-pack/cloud/link/start            { return_to } → { authorize_url }
 *   POST   /agor-pack/cloud/link/complete         fragment fields → link status
 *   POST   /agor-pack/cloud/moves                 export request → move (runs on the daemon)
 *   GET    /agor-pack/cloud/moves                 { move } the caller's latest, or null
 *   GET    /agor-pack/cloud/moves/:id             progress per teammate
 *   POST   /agor-pack/cloud/moves/:moveId/retry   { branch_id } → move
 */

import { BadRequest } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  agorCloudLinkCompleteSchema,
  agorCloudLinkStartSchema,
  agorCloudMoveRetrySchema,
  agorPackExportRequestSchema,
  ROLES,
  type TenantID,
  type User,
} from '@agor/core/types';
import type { z } from 'zod';
import { AgorCloudLinkService } from '../services/agor-cloud-link.js';
import { AgorCloudMoveService } from '../services/agor-cloud-move.js';
import type { AgorPackServiceContext } from '../services/agor-pack-export.js';
import type { AgorPackRouteContext } from './agor-pack.js';

type RouteParams = AuthenticatedParams & { route?: Record<string, string> };

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new BadRequest(`Invalid ${what}: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  return parsed.data;
}

export function registerAgorCloudRoutes(
  ctx: Pick<
    AgorPackRouteContext,
    'app' | 'db' | 'config' | 'agorVersion' | 'registerLongAuthenticatedRoute' | 'requireAuth'
  >
): void {
  const { app, db, config, agorVersion, registerLongAuthenticatedRoute, requireAuth } = ctx;
  const member = (action: string) => ({ role: ROLES.MEMBER, action });
  const context = (params: AuthenticatedParams): AgorPackServiceContext => ({
    app,
    db,
    config,
    tenantId: params.tenant?.tenant_id as TenantID,
    user: params.user as User,
    agorVersion,
  });
  const link = (params: AuthenticatedParams) => new AgorCloudLinkService(context(params));
  const moves = (params: AuthenticatedParams) => new AgorCloudMoveService(context(params));

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/cloud/link',
    {
      async find(params: RouteParams) {
        return link(params).status();
      },
      async remove(_id: unknown, params: RouteParams) {
        return link(params).disconnect();
      },
    },
    { find: member('connect to Agor Cloud'), remove: member('connect to Agor Cloud') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/cloud/link/start',
    {
      async create(data: unknown, params: RouteParams) {
        const body = parse(agorCloudLinkStartSchema, data, 'sign-in request');
        return link(params).start(body.return_to);
      },
    },
    { create: member('connect to Agor Cloud') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/cloud/link/complete',
    {
      async create(data: unknown, params: RouteParams) {
        return link(params).complete(parse(agorCloudLinkCompleteSchema, data, 'sign-in'));
      },
    },
    { create: member('connect to Agor Cloud') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/cloud/moves',
    {
      async create(data: unknown, params: RouteParams) {
        return moves(params).start(parse(agorPackExportRequestSchema, data, 'move request'));
      },
      async find(params: RouteParams) {
        return { move: moves(params).latest() };
      },
      async get(moveId: string, params: RouteParams) {
        return moves(params).get(moveId);
      },
    },
    {
      create: member('move teammates to Agor Cloud'),
      find: member('move teammates to Agor Cloud'),
      get: member('move teammates to Agor Cloud'),
    },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/cloud/moves/:moveId/retry',
    {
      async create(data: unknown, params: RouteParams) {
        const body = parse(agorCloudMoveRetrySchema, data, 'retry request');
        return moves(params).retry(String(params.route?.moveId ?? ''), body.branch_id);
      },
    },
    { create: member('move teammates to Agor Cloud') },
    requireAuth
  );
}
