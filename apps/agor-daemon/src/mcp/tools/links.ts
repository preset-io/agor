import type {
  Link,
  LinkCreate,
  LinkKind,
  LinkPatch,
  LinkPromotionRequest,
  LinkPromotionTarget,
} from '@agor/core/types';
import { LINK_PROMOTION_TARGET } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveBranchId, resolveSessionId } from '../resolve-ids.js';
import { mcpLimit, mcpOptionalId, mcpRequiredId } from '../schema.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

const LINKS_SERVICE = 'links';
const SESSIONS_SERVICE = 'sessions';
const LINK_PLACEMENTS_SERVICE = '/links/:sourceLinkId/placements';
const LINK_SOURCE_MANUAL = 'manual';
const LINK_KIND = {
  issue: 'issue',
  pullRequest: 'pr',
  knowledge: 'kb_ref',
  url: 'url',
} as const satisfies Record<string, LinkKind>;
const LINK_TOOL = {
  list: 'agor_links_list',
  get: 'agor_links_get',
  create: 'agor_links_create',
  update: 'agor_links_update',
  promote: 'agor_links_promote',
  removeFrom: 'agor_links_remove_from',
  delete: 'agor_links_delete',
} as const;
const LINK_TARGET = {
  knowledgePrefix: 'agor://kb/',
  httpProtocol: 'http:',
  httpsProtocol: 'https:',
  githubHost: 'github.com',
} as const;
const LINK_TOOL_ERROR = {
  ownerConflict: 'Provide either branchId or sessionId, not both.',
  ownerRequired:
    'A link owner is required. Provide branchId or sessionId, or call from a current Agor session.',
  targetConflict: 'Provide exactly one target: url or refUri.',
  emptyPatch: 'Provide at least one mutable field to update.',
  immutableTarget: 'Only manual links can change target.',
  httpTargetRequired: 'Only HTTP(S) targets are supported',
  targetBranchRequired: 'Provide branchId when promoting to a teammate.',
  targetSessionRequired: 'Provide sessionId when the current session is not the destination.',
} as const;
const LINK_LIMIT = {
  titleLength: 200,
} as const;

const PUBLIC_LINK_KINDS = [
  LINK_KIND.issue,
  LINK_KIND.pullRequest,
  LINK_KIND.knowledge,
  LINK_KIND.url,
] as const;
const linkKindSchema = z.enum(PUBLIC_LINK_KINDS);
const linkPromotionDestinationSchema = z.enum([
  LINK_PROMOTION_TARGET.branch,
  LINK_PROMOTION_TARGET.session,
  LINK_PROMOTION_TARGET.teammate,
]);
const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === LINK_TARGET.httpProtocol || protocol === LINK_TARGET.httpsProtocol;
  }, LINK_TOOL_ERROR.httpTargetRequired);
const nullableTitleSchema = z.string().max(LINK_LIMIT.titleLength).nullable().optional();
const nullableMetadataSchema = z.record(z.string(), z.unknown()).nullable().optional();

function inferLinkKind(url?: string, refUri?: string): LinkKind {
  if (refUri) return LINK_KIND.knowledge;
  if (!url) return LINK_KIND.url;
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.toLowerCase() === LINK_TARGET.githubHost &&
      /^\/[^/]+\/[^/]+\/issues\/\d+(?:\/|$)/i.test(parsed.pathname)
    ) {
      return LINK_KIND.issue;
    }
    if (
      parsed.hostname.toLowerCase() === LINK_TARGET.githubHost &&
      /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/i.test(parsed.pathname)
    ) {
      return LINK_KIND.pullRequest;
    }
  } catch {
    return LINK_KIND.url;
  }
  return LINK_KIND.url;
}

type PublicLinkTarget =
  | { url: string; ref_uri: null; file_path: null }
  | { url: null; ref_uri: string; file_path: null };

function targetFields(url?: string, refUri?: string): PublicLinkTarget {
  if (Boolean(url) === Boolean(refUri)) throw new Error(LINK_TOOL_ERROR.targetConflict);
  if (url) return { url, ref_uri: null, file_path: null };
  return { url: null, ref_uri: refUri as string, file_path: null };
}

function normalizedTitle(title: string | null | undefined): string | null {
  return title?.trim() || null;
}

async function resolvePlacementRequest(
  ctx: McpContext,
  args: {
    branchId?: string;
    sessionId?: string;
    destination: LinkPromotionTarget;
  }
): Promise<LinkPromotionRequest> {
  if (args.destination === LINK_PROMOTION_TARGET.session) {
    const sessionId = args.sessionId ?? ctx.sessionId;
    if (!sessionId) throw new Error(LINK_TOOL_ERROR.targetSessionRequired);
    return {
      target: LINK_PROMOTION_TARGET.session,
      session_id: await resolveSessionId(ctx, sessionId),
    };
  }
  if (args.branchId) {
    const branchId = await resolveBranchId(ctx, args.branchId);
    return args.destination === LINK_PROMOTION_TARGET.teammate
      ? { target: LINK_PROMOTION_TARGET.teammate, teammate_branch_id: branchId }
      : { target: LINK_PROMOTION_TARGET.branch, branch_id: branchId };
  }
  if (args.destination === LINK_PROMOTION_TARGET.teammate) {
    throw new Error(LINK_TOOL_ERROR.targetBranchRequired);
  }
  if (!ctx.sessionId) throw new Error(LINK_TOOL_ERROR.ownerRequired);
  const session = await ctx.app.service(SESSIONS_SERVICE).get(ctx.sessionId, ctx.baseServiceParams);
  return { target: LINK_PROMOTION_TARGET.branch, branch_id: session.branch_id };
}

async function resolveOwner(
  ctx: McpContext,
  args: { branchId?: string; sessionId?: string }
): Promise<
  | { branch_id: Awaited<ReturnType<typeof resolveBranchId>>; session_id: null }
  | {
      branch_id: null;
      session_id: Awaited<ReturnType<typeof resolveSessionId>>;
    }
> {
  if (args.branchId && args.sessionId) throw new Error(LINK_TOOL_ERROR.ownerConflict);
  if (args.branchId) {
    return { branch_id: await resolveBranchId(ctx, args.branchId), session_id: null };
  }
  const sessionId = args.sessionId ?? ctx.sessionId;
  if (sessionId) {
    return { branch_id: null, session_id: await resolveSessionId(ctx, sessionId) };
  }
  throw new Error(LINK_TOOL_ERROR.ownerRequired);
}

export function registerLinkTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    LINK_TOOL.list,
    {
      description:
        'List visible links. Filter by branch or session. With no owner filter, a current-session caller receives both its session links and branch links.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({
        branchId: mcpOptionalId('branchId', 'Branch', 'Filter by branch owner'),
        sessionId: mcpOptionalId('sessionId', 'Session', 'Filter by session owner'),
        pinned: z.boolean().optional().describe('Filter by pinned state'),
        limit: mcpLimit(100),
      }),
    },
    async (args) => {
      if (args.branchId && args.sessionId) throw new Error(LINK_TOOL_ERROR.ownerConflict);
      const service = ctx.app.service(LINKS_SERVICE);
      const commonQuery = {
        ...(args.pinned === undefined ? {} : { is_pinned: args.pinned }),
        $limit: args.limit,
      };
      if (args.branchId) {
        const branchId = await resolveBranchId(ctx, args.branchId);
        return textResult(
          await service.find({
            query: { ...commonQuery, branch_id: branchId },
            ...ctx.baseServiceParams,
          })
        );
      }
      if (args.sessionId) {
        const sessionId = await resolveSessionId(ctx, args.sessionId);
        return textResult(
          await service.find({
            query: { ...commonQuery, session_id: sessionId },
            ...ctx.baseServiceParams,
          })
        );
      }
      if (!ctx.sessionId) throw new Error(LINK_TOOL_ERROR.ownerRequired);
      const session = await ctx.app
        .service(SESSIONS_SERVICE)
        .get(ctx.sessionId, ctx.baseServiceParams);
      const [sessionLinks, branchLinks] = await Promise.all([
        service.find({
          query: { ...commonQuery, session_id: session.session_id },
          ...ctx.baseServiceParams,
        }),
        service.find({
          query: { ...commonQuery, branch_id: session.branch_id },
          ...ctx.baseServiceParams,
        }),
      ]);
      const rows = [sessionLinks, branchLinks].flatMap((result) =>
        Array.isArray(result) ? result : result.data
      );
      return textResult({ data: rows, total: rows.length });
    }
  );

  server.registerTool(
    LINK_TOOL.get,
    {
      description:
        'Get one visible link, including owner, target, label, pin state, provenance, and read-only metadata.',
      annotations: { readOnlyHint: true },
      inputSchema: z.strictObject({ linkId: mcpRequiredId('linkId', 'Link') }),
    },
    async (args) =>
      textResult(await ctx.app.service(LINKS_SERVICE).get(args.linkId, ctx.baseServiceParams))
  );

  server.registerTool(
    LINK_TOOL.create,
    {
      description:
        'Create a manual web or knowledge link owned by a branch or session. Ownership, provenance, target_key, creator, timestamps, and revision are server-controlled after creation.',
      inputSchema: z.strictObject({
        branchId: mcpOptionalId('branchId', 'Branch', 'Branch owner'),
        sessionId: mcpOptionalId('sessionId', 'Session', 'Session owner'),
        url: httpUrlSchema.optional().describe('HTTP(S) target'),
        refUri: z
          .string()
          .startsWith(LINK_TARGET.knowledgePrefix)
          .optional()
          .describe('Knowledge target'),
        kind: linkKindSchema.optional().describe('Target kind; inferred when omitted'),
        title: nullableTitleSchema.describe('Optional display label'),
        pinned: z.boolean().optional().describe('Initial pin state'),
        metadata: nullableMetadataSchema.describe('Public caller-owned metadata'),
      }),
    },
    async (args) => {
      const owner = await resolveOwner(ctx, args);
      const target = targetFields(args.url, args.refUri);
      const payload = {
        ...owner,
        ...target,
        kind: args.kind ?? inferLinkKind(args.url, args.refUri),
        source: LINK_SOURCE_MANUAL,
        title: normalizedTitle(args.title),
        is_pinned: args.pinned ?? false,
        metadata: args.metadata ?? null,
      } satisfies LinkCreate;
      return textResult(
        await ctx.app.service(LINKS_SERVICE).create(payload, ctx.baseServiceParams)
      );
    }
  );

  server.registerTool(
    LINK_TOOL.update,
    {
      description:
        'Update mutable link properties. Labels and pin state can be changed on persisted links; only manual links can change target or kind. Omitted fields remain unchanged.',
      inputSchema: z.strictObject({
        linkId: mcpRequiredId('linkId', 'Link'),
        url: httpUrlSchema.optional().describe('Replacement HTTP(S) target'),
        refUri: z
          .string()
          .startsWith(LINK_TARGET.knowledgePrefix)
          .optional()
          .describe('Replacement knowledge target'),
        kind: linkKindSchema.optional(),
        title: nullableTitleSchema.describe('Display label; null restores the derived label'),
        pinned: z.boolean().optional(),
        metadata: nullableMetadataSchema.describe('Public caller-owned metadata'),
      }),
    },
    async (args) => {
      const { linkId, url, refUri, kind, title, pinned, metadata } = args;
      const hasTargetPatch = url !== undefined || refUri !== undefined;
      const patch: LinkPatch = {};
      if (kind !== undefined) patch.kind = kind;
      if (title !== undefined) patch.title = normalizedTitle(title);
      if (pinned !== undefined) patch.is_pinned = pinned;
      if (metadata !== undefined) patch.metadata = metadata;
      if (hasTargetPatch) {
        Object.assign(patch, targetFields(url, refUri));
        if (kind === undefined) patch.kind = inferLinkKind(url, refUri);
      }
      if (Object.keys(patch).length === 0) throw new Error(LINK_TOOL_ERROR.emptyPatch);
      if (hasTargetPatch || kind !== undefined) {
        const existing = (await ctx.app
          .service(LINKS_SERVICE)
          .get(linkId, ctx.baseServiceParams)) as Link;
        if (existing.source !== LINK_SOURCE_MANUAL)
          throw new Error(LINK_TOOL_ERROR.immutableTarget);
      }
      return textResult(
        await ctx.app.service(LINKS_SERVICE).patch(linkId, patch, ctx.baseServiceParams)
      );
    }
  );

  server.registerTool(
    LINK_TOOL.promote,
    {
      description:
        'Promote a visible link to a branch, session, or teammate without removing it from its source owner. Branch promotion defaults to the current session branch; session promotion defaults to the current session; teammate promotion requires branchId.',
      inputSchema: z.strictObject({
        linkId: mcpRequiredId('linkId', 'Link'),
        destination: linkPromotionDestinationSchema,
        branchId: mcpOptionalId('branchId', 'Branch', 'Destination branch'),
        sessionId: mcpOptionalId('sessionId', 'Session', 'Destination session'),
      }),
    },
    async (args) => {
      const request = await resolvePlacementRequest(ctx, args);
      return textResult(
        await ctx.app.service(LINK_PLACEMENTS_SERVICE).create(request, {
          ...ctx.baseServiceParams,
          route: { sourceLinkId: args.linkId },
        })
      );
    }
  );

  server.registerTool(
    LINK_TOOL.removeFrom,
    {
      description:
        'Remove a visible link from one branch, session, or teammate context without removing its other placements.',
      annotations: { destructiveHint: true },
      inputSchema: z.strictObject({
        linkId: mcpRequiredId('linkId', 'Link'),
        destination: linkPromotionDestinationSchema,
        branchId: mcpOptionalId('branchId', 'Branch', 'Context branch'),
        sessionId: mcpOptionalId('sessionId', 'Session', 'Context session'),
      }),
    },
    async (args) => {
      const request = await resolvePlacementRequest(ctx, args);
      const removed = await ctx.app.service(LINK_PLACEMENTS_SERVICE).remove(null, {
        ...ctx.baseServiceParams,
        route: { sourceLinkId: args.linkId },
        query: request,
      });
      return textResult({ success: true, link: removed });
    }
  );

  server.registerTool(
    LINK_TOOL.delete,
    {
      description:
        'Delete a saved link. This does not delete its target or original source message.',
      annotations: { destructiveHint: true },
      inputSchema: z.strictObject({ linkId: mcpRequiredId('linkId', 'Link') }),
    },
    async (args) => {
      const removed = await ctx.app
        .service(LINKS_SERVICE)
        .remove(args.linkId, ctx.baseServiceParams);
      return textResult({ success: true, link: removed });
    }
  );
}
