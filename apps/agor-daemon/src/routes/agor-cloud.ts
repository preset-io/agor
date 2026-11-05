/**
 * Self-hosted "Sign in to Agor Cloud" and "Send to Agor Cloud" (Settings →
 * Move to Agor Cloud). Long authenticated routes, MEMBER, each caller only
 * ever reads or changes their own link and transfers.
 *
 *   GET    /agor-pack/cloud/link                       { console_url, link } (no tokens)
 *   DELETE /agor-pack/cloud/link                       forget the link
 *   POST   /agor-pack/cloud/link/start                 { return_to } → { authorize_url }
 *   POST   /agor-pack/cloud/link/complete              fragment fields → link status
 *   POST   /agor-pack/cloud/transfers                  { export_id, ref } → transfer
 *   GET    /agor-pack/cloud/transfers/:id              progress, receipt
 *   POST   /agor-pack/cloud/transfers/:transferId/apply { teammates } → transfer
 */

import { BadRequest } from '@agor/core/feathers';
import {
  type AuthenticatedParams,
  agorCloudLinkCompleteSchema,
  agorCloudLinkStartSchema,
  agorCloudTransferApplySchema,
  agorCloudTransferStartSchema,
  ROLES,
  type TenantID,
  type User,
} from '@agor/core/types';
import type { z } from 'zod';
import { type AgorCloudLinkContext, AgorCloudLinkService } from '../services/agor-cloud-link.js';
import { AgorCloudTransferService } from '../services/agor-cloud-transfer.js';
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
    'app' | 'db' | 'config' | 'registerLongAuthenticatedRoute' | 'requireAuth'
  >
): void {
  const { app, db, config, registerLongAuthenticatedRoute, requireAuth } = ctx;
  const member = (action: string) => ({ role: ROLES.MEMBER, action });
  const context = (params: AuthenticatedParams): AgorCloudLinkContext => ({
    db,
    config,
    tenantId: params.tenant?.tenant_id as TenantID,
    user: params.user as User,
  });
  const link = (params: AuthenticatedParams) => new AgorCloudLinkService(context(params));
  const transfers = (params: AuthenticatedParams) => new AgorCloudTransferService(context(params));

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
    '/agor-pack/cloud/transfers',
    {
      async create(data: unknown, params: RouteParams) {
        const body = parse(agorCloudTransferStartSchema, data, 'transfer');
        return transfers(params).start(body.export_id, body.ref);
      },
      async get(transferId: string, params: RouteParams) {
        return transfers(params).get(transferId);
      },
    },
    { create: member('send teammates to Agor Cloud'), get: member('send teammates to Agor Cloud') },
    requireAuth
  );

  registerLongAuthenticatedRoute(
    app,
    '/agor-pack/cloud/transfers/:transferId/apply',
    {
      async create(data: unknown, params: RouteParams) {
        const body = parse(agorCloudTransferApplySchema, data, 'import request');
        return transfers(params).apply(String(params.route?.transferId ?? ''), body.teammates);
      },
    },
    { create: member('send teammates to Agor Cloud') },
    requireAuth
  );
}
