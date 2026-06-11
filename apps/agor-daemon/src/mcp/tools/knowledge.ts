import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BranchRepository, KnowledgeNamespaceRepository } from '@agor/core/db';
import { NotFound } from '@agor/core/feathers';
import type {
  AssistantKnowledgeGrantAccess,
  Branch,
  BranchID,
  KnowledgeDocumentKind,
  KnowledgeDocumentStatus,
  KnowledgeDocumentVersion,
  KnowledgeEditPolicy,
  KnowledgeGraphEdgeType,
  KnowledgeGraphNodeType,
  KnowledgeNamespace,
  KnowledgeVisibility,
  User,
  UserRole,
} from '@agor/core/types';
import {
  buildKnowledgeDocumentUri,
  getAssistantConfig,
  isAssistant,
  KNOWLEDGE_DOCUMENT_KINDS,
  KNOWLEDGE_DOCUMENT_STATUSES,
  KNOWLEDGE_DOCUMENT_URI_PREFIX,
  KNOWLEDGE_EDIT_POLICIES,
  KNOWLEDGE_GRAPH_EDGE_TYPES,
  KNOWLEDGE_GRAPH_NODE_TYPES,
  KNOWLEDGE_VISIBILITIES,
  normalizeKnowledgeDocumentIconEmoji,
  parseKnowledgeUri,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import {
  markdownOutline,
  resolveHeadingRange,
  splitMarkdownLines,
} from '../../knowledge/markdown-outline.js';
import {
  ASSISTANT_MEMORY_PATH_TEMPLATE,
  ASSISTANT_NAMESPACE_MISSING_MESSAGE,
} from '../../services/assistant-knowledge.js';
import {
  hasKnowledgeNamespacePermission,
  resolveKnowledgeNamespacePermission,
} from '../../services/knowledge-access.js';
import { resolveBranchWorkspacePath } from '../../utils/branch-workspace-path.js';
import { resolveBranchId } from '../resolve-ids.js';
import {
  mcpLimit,
  mcpOptionalId,
  mcpOptionalNonBlankString,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpRequiredId,
  mcpRequiredPositiveInt,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import {
  coerceJsonRecord,
  coerceString,
  sessionContextRequiredResult,
  textResult,
} from '../server.js';

const KnowledgeDocumentKindSchema = z.enum(KNOWLEDGE_DOCUMENT_KINDS);
const KnowledgeDocumentStatusSchema = z.enum(KNOWLEDGE_DOCUMENT_STATUSES);
const KnowledgeVisibilitySchema = z.enum(KNOWLEDGE_VISIBILITIES);
const KnowledgeEditPolicySchema = z.enum(KNOWLEDGE_EDIT_POLICIES);
const KnowledgeGraphNodeTypeSchema = z.enum(KNOWLEDGE_GRAPH_NODE_TYPES);
const KnowledgeGraphEdgeTypeSchema = z.enum(KNOWLEDGE_GRAPH_EDGE_TYPES);

function mcpOptionalVersionToken(fieldName: string, description: string) {
  return z
    .union([
      z.number({
        error: `${fieldName} must be a version number or version ID when provided.`,
      }),
      z
        .string({
          error: `${fieldName} must be a version number or version ID when provided.`,
        })
        .min(1, `${fieldName} cannot be empty.`),
    ])
    .optional()
    .describe(description);
}

const KnowledgeReplaceLineRangeOpSchema = z.object({
  type: z.literal('replace_line_range'),
  startLine: mcpRequiredPositiveInt('startLine', '1-based inclusive start line'),
  endLine: mcpRequiredPositiveInt('endLine', '1-based inclusive end line'),
  replacement: z.string({
    error: 'replacement is required and must be a string.',
  }),
  expectedText: mcpOptionalString('expectedText', 'Expected text for optimistic edit checks'),
  expectedMd5: mcpOptionalString('expectedMd5', 'Expected MD5 for optimistic edit checks'),
});

const KnowledgeInsertAtLineOpSchema = z.object({
  type: z.literal('insert_at_line'),
  line: mcpRequiredPositiveInt('line', '1-based line number'),
  position: z.enum(['before', 'after']).optional(),
  content: z.string({
    error: 'content is required and must be a string.',
  }),
  expectedNeighborText: mcpOptionalString(
    'expectedNeighborText',
    'Expected adjacent text for optimistic edit checks'
  ),
});

const KnowledgeDeleteLineRangeOpSchema = z.object({
  type: z.literal('delete_line_range'),
  startLine: mcpRequiredPositiveInt('startLine', '1-based inclusive start line'),
  endLine: mcpRequiredPositiveInt('endLine', '1-based inclusive end line'),
  expectedText: mcpOptionalString('expectedText', 'Expected text for optimistic edit checks'),
  expectedMd5: mcpOptionalString('expectedMd5', 'Expected MD5 for optimistic edit checks'),
});

const KnowledgeReplaceLiteralOpSchema = z.object({
  type: z.literal('replace_literal'),
  find: mcpRequiredString('find', 'Literal text to replace'),
  replace: z.string({
    error: 'replace is required and must be a string.',
  }),
  expectedCount: z
    .number({
      error: 'expectedCount is required and must be a non-negative integer.',
    })
    .int('expectedCount must be an integer.')
    .nonnegative('expectedCount must be greater than or equal to 0.'),
});

const KnowledgeEditOpSchema = z.discriminatedUnion('type', [
  KnowledgeReplaceLineRangeOpSchema,
  KnowledgeInsertAtLineOpSchema,
  KnowledgeDeleteLineRangeOpSchema,
  KnowledgeReplaceLiteralOpSchema,
]);

const KnowledgeEditRequestSchema = z.object({
  documentId: mcpOptionalId('documentId', 'Knowledge document'),
  uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
  namespace: mcpOptionalNonBlankString('namespace', 'Namespace/space slug; use with path'),
  path: mcpOptionalNonBlankString('path', 'Document path inside namespace; use with namespace'),
  expectedVersion: mcpOptionalVersionToken(
    'expectedVersion',
    'Optimistic concurrency check: current version number or version ID expected by the caller'
  ),
  dryRun: z
    .boolean()
    .optional()
    .describe('When true, validate and preview without creating a new version'),
  changeSummary: mcpOptionalString('changeSummary', 'Optional change summary for version history'),
  versionMetadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Additional metadata to merge into the new version record'),
  ops: z
    .array(KnowledgeEditOpSchema)
    .min(1)
    .describe(
      'Deterministic operations to apply in order. Provide the full batch; one successful call creates one immutable KB version.'
    ),
  returnContent: z
    .enum(['none', 'full'])
    .optional()
    .describe(
      'Set to "full" to include the post-edit content in the response (default: exclude content).'
    ),
});

const KnowledgeNodeRefSchema = z
  .object(
    {
      nodeId: mcpOptionalId('nodeId', 'Knowledge graph node'),
      uri: mcpOptionalNonBlankString(
        'uri',
        'Canonical node/document URI, e.g. agor://kb/global/architecture.md'
      ),
      nodeType: KnowledgeGraphNodeTypeSchema.optional().describe(
        'Node type to resolve or create when nodeId/uri is not enough.'
      ),
      documentId: mcpOptionalId('documentId', 'Knowledge document'),
      namespace: mcpOptionalNonBlankString('namespace', 'Knowledge namespace/space slug'),
      path: mcpOptionalNonBlankString('path', 'Document path inside namespace'),
      externalUri: mcpOptionalNonBlankString(
        'externalUri',
        'External URL or URI for external nodes'
      ),
      branchId: mcpOptionalId('branchId', 'Branch'),
      sessionId: mcpOptionalId('sessionId', 'Session'),
      taskId: mcpOptionalId('taskId', 'Task'),
      messageId: mcpOptionalId('messageId', 'Message'),
      artifactId: mcpOptionalId('artifactId', 'Artifact'),
      repoId: mcpOptionalId('repoId', 'Repository'),
      boardId: mcpOptionalId('boardId', 'Board'),
      userId: mcpOptionalId('userId', 'User'),
      label: mcpOptionalString('label', 'Optional label for newly-created graph nodes'),
    },
    {
      error: 'node reference is required and must be an object.',
    }
  )
  .describe(
    'Reference to an existing or creatable knowledge graph node. Prefer nodeId or uri; use typed IDs for links to Agor core objects.'
  );

type OptionalService = Record<string, unknown>;

type CallableService = OptionalService & {
  find?: (params?: Record<string, unknown>) => Promise<unknown>;
  get?: (id: string, params?: Record<string, unknown>) => Promise<unknown>;
  create?: (data: unknown, params?: Record<string, unknown>) => Promise<unknown>;
  patch?: (id: string, data: unknown, params?: Record<string, unknown>) => Promise<unknown>;
};

function getOptionalService(ctx: McpContext, path: string): CallableService | undefined {
  const app = ctx.app as unknown as {
    services?: Record<string, unknown>;
    service: (path: string) => unknown;
  };

  if (app.services && !(path in app.services)) return undefined;

  try {
    return app.service(path) as CallableService;
  } catch {
    return undefined;
  }
}

function knowledgeNotImplementedResult(toolName: string, servicePaths: string[]) {
  return {
    ...textResult({
      error: `${toolName} is scaffolded, but the Knowledge backend services are not registered yet.`,
      status: 'not_implemented',
      service_paths: servicePaths,
      todo: 'Wire this MCP tool to the corresponding /kb/* Feathers service once the Knowledge repository/service layer lands.',
    }),
    isError: true,
  };
}

function mcpParams(ctx: McpContext, query?: Record<string, unknown>): Record<string, unknown> {
  return query ? { ...ctx.baseServiceParams, query } : { ...ctx.baseServiceParams };
}

/**
 * Decorate Knowledge documents in a service result with `reference_uri` — the
 * rename-proof `agor://kb/document/<id>` link to embed in other docs' markdown
 * (an embedded link auto-creates a `references` graph edge on save). Walks
 * arrays, Feathers `{ data }` pages, bare documents, hydrated documents (which
 * also carry a nested `document`), and search rows that wrap a `document`.
 */
function enrichWithReferenceUri(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(enrichWithReferenceUri);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    return { ...obj, data: obj.data.map(enrichWithReferenceUri) };
  }
  let next = obj;
  if (typeof obj.document_id === 'string') {
    next = { ...next, reference_uri: buildKnowledgeDocumentUri(obj.document_id) };
  }
  if (obj.document && typeof obj.document === 'object') {
    next = { ...next, document: enrichWithReferenceUri(obj.document) };
  }
  return next;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.map((item) => coerceString(item)).filter((item): item is string => Boolean(item))
    : undefined;
}

async function callCustomMethod(
  service: OptionalService,
  methodName: string,
  data: unknown,
  params: Record<string, unknown>
): Promise<unknown | undefined> {
  const method = service[methodName];
  if (typeof method !== 'function') return undefined;
  return (method as (data: unknown, params?: Record<string, unknown>) => Promise<unknown>).call(
    service,
    data,
    params
  );
}

type HydratedKnowledgeDocumentResult = Record<string, unknown> & {
  document?: Record<string, unknown>;
  current_version?: KnowledgeDocumentVersion | null;
  content?: string | null;
};

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function versionToken(version: KnowledgeDocumentVersion | null | undefined) {
  if (!version) return null;
  return {
    version_id: version.version_id,
    version_number: version.version_number,
    content_sha256: version.content_sha256 ?? null,
    etag: `kbv:${version.version_id}`,
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof NotFound ||
    (typeof error === 'object' &&
      error !== null &&
      ((error as { code?: unknown }).code === 404 ||
        (error as { name?: unknown }).name === 'NotFound'))
  );
}

function namespaceSlugForDocument(result: HydratedKnowledgeDocumentResult): string | undefined {
  const doc = result.document ?? result;
  const uri = typeof doc.uri === 'string' ? doc.uri : undefined;
  return parseKnowledgeUri(uri)?.namespace_slug;
}

function documentPathForResult(result: HydratedKnowledgeDocumentResult): string | undefined {
  const doc = result.document ?? result;
  return typeof doc.path === 'string' ? doc.path : undefined;
}

async function fetchKnowledgeDocument(
  ctx: McpContext,
  ref: {
    documentId?: string;
    uri?: string;
    namespace?: string;
    path?: string;
    includeContent?: boolean;
    version?: string | number;
  }
): Promise<HydratedKnowledgeDocumentResult> {
  const service = getOptionalService(ctx, 'kb/documents');
  if (!service) throw new Error('Knowledge documents service is not registered');
  const includeContent = ref.includeContent !== false;

  const documentId = coerceString(ref.documentId);
  if (documentId) {
    if (!service.get) throw new Error('kb/documents.get is not available');
    return (await service.get(
      documentId,
      mcpParams(ctx, { include_content: includeContent, version: ref.version })
    )) as HydratedKnowledgeDocumentResult;
  }

  const uri = coerceString(ref.uri);
  if (uri?.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX)) {
    const idFromUri = uri.slice(KNOWLEDGE_DOCUMENT_URI_PREFIX.length);
    if (!service.get) throw new Error('kb/documents.get is not available');
    return (await service.get(
      idFromUri,
      mcpParams(ctx, { include_content: includeContent, version: ref.version })
    )) as HydratedKnowledgeDocumentResult;
  }

  const parsedUri = parseKnowledgeUri(uri);
  const namespace = coerceString(ref.namespace) ?? parsedUri?.namespace_slug;
  const docPath = coerceString(ref.path) ?? parsedUri?.path;
  if (!namespace || !docPath) {
    throw new Error(
      'Provide documentId, a valid agor://kb/<namespace>/<path> uri, or namespace + path.'
    );
  }

  const customResult = await callCustomMethod(
    service,
    'getDocument',
    {
      uri,
      namespace_slug: namespace,
      path: docPath,
      include_content: includeContent,
      version: ref.version,
    },
    mcpParams(ctx)
  );
  if (customResult !== undefined) return customResult as HydratedKnowledgeDocumentResult;
  throw new Error('kb/documents.getDocument is not available');
}

function materializationSidecarSubpath(markdownSubpath: string): string {
  return `${markdownSubpath}.agor-kb.json`;
}

async function writeKnowledgeMaterializationSidecar(
  sidecarPath: string,
  sidecar: Record<string, unknown>
): Promise<void> {
  await writeFile(
    sidecarPath,
    `${JSON.stringify(sidecar, null, 2)}
`,
    'utf-8'
  );
}

function renderAssistantMemoryPath(template: string | undefined, date: string): string {
  return (template || ASSISTANT_MEMORY_PATH_TEMPLATE).replace('{{YYYY-MM-DD}}', date);
}

function normalizeMemoryBullets(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? input : input.split('\n');
  return raw.map((item) => item.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
}

function memoryEntryHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const ASSISTANT_POLICY_RANK: Record<AssistantKnowledgeGrantAccess, number> = {
  none: 0,
  read: 1,
  write: 2,
};

function assistantPolicyAllows(
  branch: Branch,
  namespace: KnowledgeNamespace,
  required: Exclude<AssistantKnowledgeGrantAccess, 'none'>
): boolean {
  const assistant = getAssistantConfig(branch);
  const kb = assistant?.kb;
  if (!kb) return false;
  if (
    namespace.namespace_id === kb.primary_namespace_id ||
    namespace.slug === kb.primary_namespace_slug
  ) {
    return true;
  }
  const grant = (kb.grants ?? []).find(
    (entry) =>
      entry.namespace_id === namespace.namespace_id || entry.namespace_slug === namespace.slug
  );
  const access = grant?.access ?? kb.global_access ?? 'write';
  return ASSISTANT_POLICY_RANK[access] >= ASSISTANT_POLICY_RANK[required];
}

async function resolveAssistantKnowledgeContext(ctx: McpContext): Promise<{
  branch: Branch;
  namespace: KnowledgeNamespace;
}> {
  if (!ctx.sessionId) throw new Error(ASSISTANT_NAMESPACE_MISSING_MESSAGE);
  const session = (await ctx.app.service('sessions').get(ctx.sessionId, ctx.baseServiceParams)) as {
    branch_id?: string;
  };
  const branch = (await ctx.app
    .service('branches')
    .get(String(session.branch_id), ctx.baseServiceParams)) as Branch;
  if (!isAssistant(branch)) {
    throw new Error('This tool only works from an assistant branch/session');
  }
  const assistant = getAssistantConfig(branch);
  const namespaceId = assistant?.kb?.primary_namespace_id;
  if (!namespaceId) throw new Error(ASSISTANT_NAMESPACE_MISSING_MESSAGE);
  let namespace: KnowledgeNamespace;
  try {
    namespace = (await ctx.app
      .service('kb/namespaces')
      .get(namespaceId, ctx.baseServiceParams)) as KnowledgeNamespace;
  } catch (error) {
    if (isNotFoundError(error)) throw new Error(ASSISTANT_NAMESPACE_MISSING_MESSAGE);
    throw error;
  }
  if (!namespace || namespace.archived) throw new Error(ASSISTANT_NAMESPACE_MISSING_MESSAGE);
  return { branch, namespace };
}

async function resolveKnowledgeNamespaceBySlug(
  ctx: McpContext,
  slug: string
): Promise<KnowledgeNamespace | null> {
  const service = getOptionalService(ctx, 'kb/namespaces');
  if (!service?.find) return null;
  const result = await service.find(mcpParams(ctx, { slug, archived: false }));
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { data?: unknown[] })?.data)
      ? (result as { data: unknown[] }).data
      : [];
  return (rows[0] as KnowledgeNamespace | undefined) ?? null;
}

export function registerKnowledgeTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_assistant_context',
    {
      description:
        "Read the current assistant branch's Knowledge memory/context namespace and recent memory documents. Does not mutate assistant Knowledge config or grants.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        includeMemory: z.boolean().optional().describe('Include memory documents (default: true)'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum memory docs to list'),
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const { branch, namespace } = await resolveAssistantKnowledgeContext(ctx);
      const docsService = getOptionalService(ctx, 'kb/documents');
      const memory =
        args.includeMemory === false || !docsService?.find
          ? []
          : await docsService.find(
              mcpParams(ctx, {
                namespace_id: namespace.namespace_id,
                kind: 'memory',
                include_content: true,
                include_my_drafts: true,
                limit: args.limit ?? 10,
              })
            );
      return textResult({
        branch_id: branch.branch_id,
        assistant: getAssistantConfig(branch),
        namespace,
        memory,
      });
    }
  );

  server.registerTool(
    'agor_assistant_memory_search',
    {
      description:
        "Search the current assistant branch's primary Knowledge memory namespace. Does not mutate assistant Knowledge config or grants.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Search text. Use an empty string to browse memory.'),
        limit: z.number().int().min(1).max(50).optional(),
        mode: z.enum(['text', 'semantic', 'hybrid']).optional(),
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const { namespace } = await resolveAssistantKnowledgeContext(ctx);
      const service = getOptionalService(ctx, 'kb/search');
      if (!service?.find) {
        return knowledgeNotImplementedResult('agor_assistant_memory_search', ['kb/search.find']);
      }
      return textResult(
        enrichWithReferenceUri(
          await service.find(
            mcpParams(ctx, {
              q: coerceString(args.query) ?? '',
              namespace_slug: namespace.slug,
              path_prefix: 'memory/',
              limit: args.limit ?? 10,
              mode: args.mode,
            })
          )
        )
      );
    }
  );

  server.registerTool(
    'agor_assistant_knowledge_search',
    {
      description:
        'Search Knowledge through the current assistant branch policy. The assistant policy (whole-KB fallback plus namespace overrides) is checked before the normal user namespace permissions.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Search text. Use an empty string to browse.'),
        namespace: z
          .string()
          .optional()
          .describe('Optional namespace slug. Required unless whole-KB fallback is read/write.'),
        pathPrefix: z.string().optional().describe('Optional path prefix filter.'),
        limit: z.number().int().min(1).max(50).optional(),
        mode: z.enum(['text', 'semantic', 'hybrid']).optional(),
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const { branch } = await resolveAssistantKnowledgeContext(ctx);
      const assistant = getAssistantConfig(branch);
      const globalAccess = assistant?.kb?.global_access ?? 'write';
      const service = getOptionalService(ctx, 'kb/search');
      if (!service?.find) {
        return knowledgeNotImplementedResult('agor_assistant_knowledge_search', ['kb/search.find']);
      }

      const namespaceSlug = coerceString(args.namespace);
      if (namespaceSlug) {
        const namespace = await resolveKnowledgeNamespaceBySlug(ctx, namespaceSlug);
        if (!namespace || !assistantPolicyAllows(branch, namespace, 'read')) {
          throw new Error(
            `Assistant Knowledge policy does not grant read access to namespace ${namespaceSlug}`
          );
        }
      } else if (ASSISTANT_POLICY_RANK[globalAccess] < ASSISTANT_POLICY_RANK.read) {
        throw new Error(
          'Assistant Knowledge policy does not grant whole-Knowledge-Base read access. Choose a namespace with an explicit read grant or update the assistant Knowledge policy.'
        );
      }

      return textResult(
        enrichWithReferenceUri(
          await service.find(
            mcpParams(ctx, {
              q: coerceString(args.query) ?? '',
              ...(namespaceSlug ? { namespace_slug: namespaceSlug } : {}),
              ...(args.pathPrefix ? { path_prefix: coerceString(args.pathPrefix) } : {}),
              limit: args.limit ?? 10,
              mode: args.mode,
            })
          )
        )
      );
    }
  );

  server.registerTool(
    'agor_assistant_memory_append',
    {
      description:
        "Append one or more memory bullets to the current assistant branch's daily Knowledge memory document.",
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        bullets: z.union([z.string(), z.array(z.string())]).describe('Memory bullet(s) to append'),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        category: z
          .enum(['note', 'decision', 'preference', 'project', 'learning', 'task', 'other'])
          .optional(),
        tags: z.array(z.string()).optional(),
        importance: z.enum(['low', 'normal', 'high']).optional(),
        idempotencyKey: z.string().optional(),
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const { branch, namespace } = await resolveAssistantKnowledgeContext(ctx);
      const namespaceRepo = new KnowledgeNamespaceRepository(ctx.db);
      const permission = await resolveKnowledgeNamespacePermission(
        namespaceRepo,
        namespace.namespace_id,
        ctx.authenticatedUser as unknown as User
      );
      if (!hasKnowledgeNamespacePermission(permission, 'write')) {
        throw new Error(
          `You don't have write access to namespace ${namespace.slug}. Ask a namespace owner to grant write access in Knowledge -> Settings -> Namespaces.`
        );
      }

      const bullets = normalizeMemoryBullets(args.bullets);
      if (bullets.length === 0) throw new Error('No memory bullets provided');
      const date = args.date ?? new Date().toISOString().slice(0, 10);
      const assistant = getAssistantConfig(branch);
      const docPath = renderAssistantMemoryPath(assistant?.kb?.memory_path_template, date);
      const docsService = getOptionalService(ctx, 'kb/documents');
      if (!docsService) throw new Error('Knowledge documents service is not registered');

      let existingContent = `# ${date}\n`;
      let expectedVersion: string | number | undefined;
      try {
        const existing = (await callCustomMethod(
          docsService,
          'getDocument',
          {
            namespace_slug: namespace.slug,
            path: docPath,
            include_content: true,
          },
          mcpParams(ctx)
        )) as HydratedKnowledgeDocumentResult | undefined;
        if (existing) {
          existingContent =
            typeof existing.content === 'string' ? existing.content : existingContent;
          expectedVersion = existing.current_version?.version_id;
        }
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }

      const now = new Date().toISOString();
      const category = args.category ?? 'note';
      const tags = (args.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
      const appended: Array<{ text: string; hash: string; deduped: boolean }> = [];
      const blocks: string[] = [];
      bullets.forEach((bullet, index) => {
        const key = args.idempotencyKey
          ? `${args.idempotencyKey}:${index}`
          : `${category}:${bullet}`;
        const hash = memoryEntryHash(key);
        if (existingContent.includes(`hash="${hash}"`)) {
          appended.push({ text: bullet, hash, deduped: true });
          return;
        }
        const id = args.idempotencyKey
          ? createHash('sha256').update(key).digest('hex').slice(0, 24)
          : randomUUID();
        const tagText = tags.map((tag) => ` #${tag.replace(/\s+/g, '-')}`).join('');
        const importance =
          args.importance && args.importance !== 'normal' ? ` (${args.importance})` : '';
        blocks.push(
          `<!-- agor-memory-entry id="${escapeHtmlAttr(id)}" hash="${hash}" -->\n` +
            `- [${now}] ${category}${importance}: ${bullet}${tagText}\n` +
            `  - source: agor://session/${ctx.sessionId}\n` +
            '<!-- /agor-memory-entry -->'
        );
        appended.push({ text: bullet, hash, deduped: false });
      });

      const nextContent = blocks.length
        ? `${existingContent.replace(/\s*$/, '\n\n')}${blocks.join('\n\n')}\n`
        : existingContent;
      if (blocks.length > 0) {
        const result = await callCustomMethod(
          docsService,
          'putDocument',
          {
            namespace_slug: namespace.slug,
            path: docPath,
            title: date,
            kind: 'memory',
            visibility: assistant?.kb?.default_visibility ?? namespace.visibility_default,
            edit_policy: 'public',
            status: 'published',
            content_text: nextContent,
            expected_version: expectedVersion,
            metadata: {
              assistant_memory: true,
              assistant_branch_id: branch.branch_id,
              memory_date: date,
            },
          },
          mcpParams(ctx)
        );
        return textResult({ namespace: namespace.slug, path: docPath, appended, document: result });
      }
      return textResult({ namespace: namespace.slug, path: docPath, appended });
    }
  );

  server.registerTool(
    'agor_kb_namespaces_list',
    {
      description: 'List Knowledge namespaces/spaces available to the current user.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        slug: mcpOptionalNonBlankString('slug', 'Filter by namespace/space slug'),
        kind: z
          .enum(['system', 'global', 'user', 'repo', 'branch', 'team'])
          .optional()
          .describe('Filter by namespace kind'),
        includeArchived: z.boolean().optional().describe('Include archived namespaces'),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/namespaces');
      if (!service)
        return knowledgeNotImplementedResult('agor_kb_namespaces_list', ['kb/namespaces']);

      const query: Record<string, unknown> = { archived: args.includeArchived === true };
      if (args.slug) query.slug = coerceString(args.slug);
      if (args.kind) query.kind = args.kind;

      if (service.find) return textResult(await service.find(mcpParams(ctx, query)));
      return knowledgeNotImplementedResult('agor_kb_namespaces_list', ['kb/namespaces.find']);
    }
  );

  server.registerTool(
    'agor_kb_namespace_put',
    {
      description:
        'Create or update a Knowledge namespace/space by slug. Namespaces appear in agor://kb/<namespace>/<path> URIs.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        namespaceId: mcpOptionalId('namespaceId', 'Knowledge namespace'),
        slug: mcpRequiredString('slug', 'Namespace slug used in agor://kb/<slug>/... URIs'),
        displayName: mcpOptionalString('displayName', 'Human-readable display name'),
        description: mcpOptionalString('description', 'Namespace description'),
        kind: z
          .enum(['system', 'global', 'user', 'repo', 'branch', 'team'])
          .optional()
          .describe('Namespace kind (default: global)'),
        visibilityDefault: KnowledgeVisibilitySchema.optional().describe(
          'Default document visibility'
        ),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Namespace metadata'),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/namespaces');
      if (!service)
        return knowledgeNotImplementedResult('agor_kb_namespace_put', ['kb/namespaces']);

      const slug = coerceString(args.slug);
      if (!slug) throw new Error('slug is required and must be a non-empty string.');
      const data = {
        slug,
        display_name: coerceString(args.displayName),
        description: coerceString(args.description),
        kind: args.kind,
        visibility_default: args.visibilityDefault as KnowledgeVisibility | undefined,
        metadata: coerceJsonRecord(args.metadata),
      };

      const namespaceId = coerceString(args.namespaceId);
      if (namespaceId && service.patch)
        return textResult(await service.patch(namespaceId, data, mcpParams(ctx)));

      if (service.find) {
        const existing = await service.find(mcpParams(ctx, { slug }));
        const rows = Array.isArray(existing)
          ? existing
          : Array.isArray((existing as { data?: unknown[] })?.data)
            ? (existing as { data: unknown[] }).data
            : [];
        const existingId = coerceString(
          (rows[0] as { namespace_id?: unknown } | undefined)?.namespace_id
        );
        if (existingId && service.patch)
          return textResult(await service.patch(existingId, data, mcpParams(ctx)));
      }

      if (service.create) return textResult(await service.create(data, mcpParams(ctx)));
      return knowledgeNotImplementedResult('agor_kb_namespace_put', [
        'kb/namespaces.find',
        'kb/namespaces.patch',
        'kb/namespaces.create',
      ]);
    }
  );

  server.registerTool(
    'agor_kb_search',
    {
      description:
        'Search Agor Knowledge documents. Supports text, semantic, and hybrid modes when Knowledge embeddings are enabled/configured. Each result carries a `reference_uri` (agor://kb/document/<id>) — embed that link in another doc to create a graph edge to it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z
          .string({
            error:
              'query is required and must be a string. Use an empty string to browse with filters.',
          })
          .describe('Search text. Use an empty string to browse with filters.'),
        namespace: mcpOptionalNonBlankString('namespace', 'Filter by namespace/space slug'),
        pathPrefix: mcpOptionalNonBlankString(
          'pathPrefix',
          'Filter to document paths under this prefix'
        ),
        kind: KnowledgeDocumentKindSchema.optional().describe('Filter by document kind'),
        visibility: KnowledgeVisibilitySchema.optional().describe('Filter by visibility'),
        status: KnowledgeDocumentStatusSchema.optional().describe(
          'Filter by lifecycle status: draft or published'
        ),
        includeMyDrafts: z
          .boolean()
          .optional()
          .describe('Include documents you authored with status=draft (default: true)'),
        includeOtherUserDrafts: z
          .boolean()
          .optional()
          .describe(
            "Include other users' draft documents in browsing/search (default: false). Drafts remain directly accessible by URL when visibility permits."
          ),
        includeIndexing: z
          .boolean()
          .optional()
          .describe(
            'Include per-document embedding/indexing summary: derived state, chunk counts, queue depth, model, and last error.'
          ),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived documents (default: false)'),
        limit: mcpLimit(20),
        mode: z
          .enum(['text', 'semantic', 'hybrid'])
          .optional()
          .describe(
            'Search mode. `text` is always available; `semantic` and `hybrid` require Postgres + pgvector + configured Knowledge embeddings.'
          ),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/search');
      if (!service) return knowledgeNotImplementedResult('agor_kb_search', ['kb/search']);

      const query: Record<string, unknown> = {
        q: coerceString(args.query) ?? '',
        include_archived: args.includeArchived === true,
      };
      if (args.namespace) query.namespace_slug = coerceString(args.namespace);
      if (args.pathPrefix) query.path_prefix = coerceString(args.pathPrefix);
      if (args.kind) query.kind = args.kind as KnowledgeDocumentKind;
      if (args.visibility) query.visibility = args.visibility as KnowledgeVisibility;
      if (args.status) query.status = args.status as KnowledgeDocumentStatus;
      query.include_my_drafts = args.includeMyDrafts !== false;
      query.include_other_user_drafts = args.includeOtherUserDrafts === true;
      if (args.includeIndexing === true) query.include_indexing = true;
      if (args.limit) query.limit = args.limit;
      if (args.mode) query.mode = args.mode;

      if (service.find)
        return textResult(enrichWithReferenceUri(await service.find(mcpParams(ctx, query))));
      return knowledgeNotImplementedResult('agor_kb_search', ['kb/search.find']);
    }
  );

  server.registerTool(
    'agor_kb_get',
    {
      description:
        'Get a Knowledge document by documentId, canonical URI, or namespace + path. Returns the current version content by default when the backend supports includeContent. The result carries a `reference_uri` (agor://kb/document/<id>) — embed that link in another doc to create a graph edge to it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: mcpOptionalId('documentId', 'Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString('namespace', 'Namespace/space slug; use with path'),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path inside namespace; use with namespace'
        ),
        version: mcpOptionalVersionToken(
          'version',
          'Version number or version ID. Omit for current version.'
        ),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include markdown/content text when supported (default: true)'),
        includeLinks: z
          .boolean()
          .optional()
          .describe('Include graph links/backlinks when supported'),
        includeIndexing: z
          .boolean()
          .optional()
          .describe(
            'Include per-document embedding/indexing summary: derived state, chunk counts, queue depth, model, and last error.'
          ),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/documents');
      if (!service) return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents']);

      const includeContent = args.includeContent !== false;
      const query: Record<string, unknown> = { include_content: includeContent };
      if (args.version !== undefined) query.version = args.version;
      if (args.includeLinks !== undefined) query.include_links = args.includeLinks;
      if (args.includeIndexing === true) query.include_indexing = true;

      const documentId = coerceString(args.documentId);
      if (documentId) {
        if (service.get)
          return textResult(
            enrichWithReferenceUri(await service.get(documentId, mcpParams(ctx, query)))
          );
        return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents.get']);
      }

      const uri = coerceString(args.uri);
      if (uri?.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX)) {
        const idFromUri = uri.slice(KNOWLEDGE_DOCUMENT_URI_PREFIX.length);
        if (service.get)
          return textResult(
            enrichWithReferenceUri(await service.get(idFromUri, mcpParams(ctx, query)))
          );
        return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents.get']);
      }
      if (uri) query.uri = uri;
      const parsedUri = parseKnowledgeUri(uri);
      const namespace = coerceString(args.namespace) ?? parsedUri?.namespace_slug;
      const path = coerceString(args.path) ?? parsedUri?.path;
      if (namespace) query.namespace_slug = namespace;
      if (path) query.path = path;
      if (!namespace || !path) {
        throw new Error(
          'Provide documentId, a valid agor://kb/<namespace>/<path> uri, or namespace + path.'
        );
      }

      const customResult = await callCustomMethod(
        service,
        'getDocument',
        {
          uri,
          namespace_slug: namespace,
          path,
          include_content: includeContent,
          include_links: args.includeLinks === true,
          include_indexing: args.includeIndexing === true,
          version: args.version,
        },
        mcpParams(ctx)
      );
      if (customResult !== undefined) return textResult(enrichWithReferenceUri(customResult));

      if (service.find)
        return textResult(enrichWithReferenceUri(await service.find(mcpParams(ctx, query))));
      return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents.find']);
    }
  );

  server.registerTool(
    'agor_kb_outline',
    {
      description:
        'Return a markdown heading outline for a Knowledge document, including 1-based line ranges and the current version token. Use this before targeted edits to avoid reading the full document.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: mcpOptionalId('documentId', 'Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString('namespace', 'Namespace/space slug; use with path'),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path inside namespace; use with namespace'
        ),
        version: mcpOptionalVersionToken(
          'version',
          'Version number or version ID. Omit for current version.'
        ),
        maxDepth: z
          .number({
            error: 'maxDepth must be a positive integer between 1 and 6 when provided.',
          })
          .int('maxDepth must be an integer.')
          .min(1, 'maxDepth must be greater than 0.')
          .max(6, 'maxDepth must be less than or equal to 6.')
          .optional()
          .describe('Maximum heading depth'),
      }),
    },
    async (args) => {
      const result = await fetchKnowledgeDocument(ctx, {
        documentId: coerceString(args.documentId),
        uri: coerceString(args.uri),
        namespace: coerceString(args.namespace),
        path: coerceString(args.path),
        version: args.version,
        includeContent: true,
      });
      const content = typeof result.content === 'string' ? result.content : '';
      const headings = markdownOutline(content, args.maxDepth ?? 6);
      return textResult(
        enrichWithReferenceUri({
          document: result.document ?? result,
          version: versionToken(result.current_version),
          lineCount: splitMarkdownLines(content).length,
          headings,
        })
      );
    }
  );

  server.registerTool(
    'agor_kb_get_range',
    {
      description:
        'Read a bounded line range or heading section from a Knowledge document. Returns current version metadata and optional line numbers so agents can edit without loading the full document.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: mcpOptionalId('documentId', 'Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString('namespace', 'Namespace/space slug; use with path'),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path inside namespace; use with namespace'
        ),
        version: mcpOptionalVersionToken(
          'version',
          'Version number or version ID. Omit for current version.'
        ),
        startLine: mcpOptionalPositiveInt('startLine', '1-based inclusive start line'),
        endLine: mcpOptionalPositiveInt('endLine', '1-based inclusive end line'),
        headingPath: mcpOptionalNonBlankString('headingPath', 'Heading path from agor_kb_outline'),
        occurrence: mcpOptionalPositiveInt(
          'occurrence',
          'Occurrence for duplicate heading paths (default: 1)'
        ),
        contextLines: z
          .number({
            error: 'contextLines must be a non-negative integer between 0 and 20 when provided.',
          })
          .int('contextLines must be an integer.')
          .min(0, 'contextLines must be greater than or equal to 0.')
          .max(20, 'contextLines must be less than or equal to 20.')
          .optional()
          .describe('Extra lines before/after the requested range (default: 2)'),
        includeLineNumbers: z
          .boolean()
          .optional()
          .describe('Include numberedContent for agent-friendly references (default: true)'),
      }),
    },
    async (args) => {
      const result = await fetchKnowledgeDocument(ctx, {
        documentId: coerceString(args.documentId),
        uri: coerceString(args.uri),
        namespace: coerceString(args.namespace),
        path: coerceString(args.path),
        version: args.version,
        includeContent: true,
      });
      const content = typeof result.content === 'string' ? result.content : '';
      const lines = splitMarkdownLines(content);
      let startLine = args.startLine;
      let endLine = args.endLine;
      const headingPath = coerceString(args.headingPath);
      if (headingPath) {
        const heading = resolveHeadingRange(markdownOutline(content), headingPath, args.occurrence);
        startLine = heading.startLine;
        endLine = heading.endLine;
      }
      if (!startLine || !endLine) {
        throw new Error('Provide startLine + endLine, or headingPath.');
      }
      if (endLine < startLine)
        throw new Error('endLine must be greater than or equal to startLine');
      if (endLine > lines.length) throw new Error('Requested range exceeds document length');
      const contextLines = args.contextLines ?? 2;
      const contextStartLine = Math.max(1, startLine - contextLines);
      const contextEndLine = Math.min(lines.length, endLine + contextLines);
      const contentLines = lines.slice(contextStartLine - 1, contextEndLine);
      const rangeContent = contentLines.join('\n');
      const numberedContent =
        args.includeLineNumbers === false
          ? undefined
          : contentLines.map((line, index) => `${contextStartLine + index}: ${line}`).join('\n');
      return textResult(
        enrichWithReferenceUri({
          document: result.document ?? result,
          version: versionToken(result.current_version),
          lineCount: lines.length,
          range: {
            startLine,
            endLine,
            contextStartLine,
            contextEndLine,
            content: rangeContent,
            numberedContent,
            contentMd5: md5(lines.slice(startLine - 1, endLine).join('\n')),
          },
        })
      );
    }
  );

  server.registerTool(
    'agor_kb_put',
    {
      description:
        'Create or update a markdown Knowledge document. Idempotent upsert keyed by documentId, URI, or namespace + path when the backend implements putDocument. To build the knowledge graph, embed links to other KB docs in the markdown — each resolvable link becomes a "references" edge automatically on save. Prefer the rename-proof form [label](agor://kb/document/<documentId>); [label](agor://kb/<namespace>/<path>) also works but breaks if the target moves. Get a doc\'s reference_uri from agor_kb_search or agor_kb_get.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        documentId: mcpOptionalId('documentId', 'Existing Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString(
          'namespace',
          'Namespace/space slug; required with path for new docs'
        ),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path inside namespace; required with namespace for new docs'
        ),
        title: mcpOptionalString(
          'title',
          'Optional explicit title. Prefer omitting this when `content` starts with an H1; Agor will derive the title from that heading and hide the duplicate heading in the viewer. Only provide a title when `firstLineIsTitle:false` or the content has no title heading.'
        ),
        content: z
          .string({
            error: 'content must be a string when provided.',
          })
          .optional()
          .describe(
            'Markdown content for the new version. Required when creating a new document; omit for metadata-only updates such as setting iconEmoji on an existing document. Embed [label](agor://kb/document/<documentId>) links to other KB docs to create graph edges between them.'
          ),
        firstLineIsTitle: z
          .boolean()
          .optional()
          .describe(
            'Derive the title from the first non-empty markdown line and hide that line in the read-only viewer. Defaults to true when content starts with an H1 (even if `title` is also provided) or when `title` is omitted; set false only when the explicit `title` should be separate from the markdown body.'
          ),
        kind: KnowledgeDocumentKindSchema.optional().describe('Document kind (default: doc)'),
        iconEmoji: z
          .string({ error: 'iconEmoji must be a string or null when provided.' })
          .nullable()
          .optional()
          .describe(
            'Optional emoji icon for the document. Pass null or an empty string to clear. Values are trimmed and capped to a short display-safe length.'
          ),
        visibility: KnowledgeVisibilitySchema.optional().describe(
          'Visibility (default: namespace default or public)'
        ),
        status: KnowledgeDocumentStatusSchema.optional().describe(
          'Lifecycle status (default: published). Drafts are shareable by direct URL, but hidden from other users in browsing/search by default.'
        ),
        editPolicy: KnowledgeEditPolicySchema.optional().describe('Edit policy (default: owner)'),
        createNamespace: z
          .boolean()
          .optional()
          .describe('Create the namespace if it does not already exist (default: false).'),
        namespaceDisplayName: mcpOptionalString(
          'namespaceDisplayName',
          'Display name to use when createNamespace is true.'
        ),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Parsed frontmatter metadata'),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Document/version metadata'),
        changeSummary: mcpOptionalString('changeSummary', 'Short summary for version history'),
        expectedVersion: mcpOptionalVersionToken(
          'expectedVersion',
          'Optional optimistic concurrency check: current version number or version ID expected by the caller'
        ),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/documents');
      if (!service) return knowledgeNotImplementedResult('agor_kb_put', ['kb/documents']);

      const content = typeof args.content === 'string' ? args.content : undefined;
      const uri = coerceString(args.uri);
      const parsedUri = parseKnowledgeUri(uri);
      const title = coerceString(args.title);
      const firstContentLine =
        content
          ?.split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? null;
      const contentStartsWithHeading = Boolean(firstContentLine?.match(/^#{1,6}\s+\S/));
      // Agents commonly pass both `title` and markdown beginning with `# Title`.
      // Default to deriving/hiding the first heading in that case so the viewer
      // does not render duplicate titles. Callers can opt out explicitly.
      const firstLineIsTitle =
        content === undefined
          ? args.firstLineIsTitle
          : (args.firstLineIsTitle ?? (contentStartsWithHeading || title === undefined));

      const iconEmoji =
        args.iconEmoji === undefined
          ? undefined
          : normalizeKnowledgeDocumentIconEmoji(args.iconEmoji);

      const data = {
        document_id: coerceString(args.documentId),
        uri,
        namespace_slug: coerceString(args.namespace) ?? parsedUri?.namespace_slug,
        path: coerceString(args.path) ?? parsedUri?.path,
        title,
        ...(content !== undefined ? { content_text: content } : {}),
        ...(firstLineIsTitle !== undefined ? { first_line_is_title: firstLineIsTitle } : {}),
        ...(args.kind !== undefined ? { kind: args.kind as KnowledgeDocumentKind } : {}),
        ...(args.iconEmoji !== undefined ? { icon_emoji: iconEmoji } : {}),
        visibility: args.visibility as KnowledgeVisibility | undefined,
        status: args.status as KnowledgeDocumentStatus | undefined,
        edit_policy: args.editPolicy as KnowledgeEditPolicy | undefined,
        create_namespace: args.createNamespace === true,
        namespace_display_name: coerceString(args.namespaceDisplayName),
        frontmatter: coerceJsonRecord(args.frontmatter),
        metadata: coerceJsonRecord(args.metadata),
        change_summary: coerceString(args.changeSummary),
        expected_version: args.expectedVersion,
      };

      const documentId = coerceString(args.documentId);
      if (!documentId && (!data.namespace_slug || !data.path)) {
        throw new Error(
          'Provide documentId, a valid agor://kb/<namespace>/<path> uri, or namespace + path.'
        );
      }

      const customResult = await callCustomMethod(service, 'putDocument', data, mcpParams(ctx));
      if (customResult !== undefined) return textResult(customResult);

      if (documentId && service.patch) {
        return textResult(await service.patch(documentId, data, mcpParams(ctx)));
      }

      if (service.create) return textResult(await service.create(data, mcpParams(ctx)));
      return knowledgeNotImplementedResult('agor_kb_put', [
        'kb/documents.putDocument',
        'kb/documents.patch',
        'kb/documents.create',
      ]);
    }
  );

  server.registerTool(
    'agor_kb_edit',
    {
      description:
        'Apply a batch of deterministic edits to a Knowledge document. One successful call creates exactly one new immutable KB version — collect related micro-edits into a single ops[] batch instead of calling this tool repeatedly. Supports dry-run previews for validation.',
      annotations: { idempotentHint: false },
      inputSchema: KnowledgeEditRequestSchema,
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/document-edits');
      if (!service) {
        return knowledgeNotImplementedResult('agor_kb_edit', ['kb/document-edits']);
      }

      const data = {
        documentId: coerceString(args.documentId),
        uri: coerceString(args.uri),
        namespace: coerceString(args.namespace),
        path: coerceString(args.path),
        expectedVersion: args.expectedVersion,
        dryRun: args.dryRun === true,
        changeSummary: coerceString(args.changeSummary),
        versionMetadata: coerceJsonRecord(args.versionMetadata),
        ops: args.ops,
        returnContent: args.returnContent ?? undefined,
      } as Record<string, unknown>;

      if (service.create) {
        return textResult(await service.create(data, mcpParams(ctx)));
      }
      return knowledgeNotImplementedResult('agor_kb_edit', ['kb/document-edits.create']);
    }
  );

  server.registerTool(
    'agor_kb_materialize',
    {
      description:
        'Write a Knowledge document version to a markdown file inside a branch worktree. Requires branchId + branch-relative subpath (or defaults to .agor/kb/<namespace>/<path>) and verifies the caller has branch session permission.',
      inputSchema: z.object({
        documentId: mcpOptionalId('documentId', 'Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString('namespace', 'Namespace/space slug; use with path'),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path inside namespace; use with namespace'
        ),
        version: mcpOptionalVersionToken(
          'version',
          'Version number or version ID. Omit for current version.'
        ),
        branchId: mcpRequiredId('branchId', 'Destination branch/worktree'),
        subpath: mcpOptionalNonBlankString(
          'subpath',
          'Branch-relative destination markdown path. Default: .agor/kb/<namespace>/<document path>.'
        ),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            'Overwrite the destination file and sidecar if they already exist. Default: false.'
          ),
      }),
    },
    async (args) => {
      const result = await fetchKnowledgeDocument(ctx, {
        documentId: coerceString(args.documentId),
        uri: coerceString(args.uri),
        namespace: coerceString(args.namespace),
        path: coerceString(args.path),
        version: args.version,
        includeContent: true,
      });
      const content = typeof result.content === 'string' ? result.content : '';
      const namespaceSlug = namespaceSlugForDocument(result) ?? coerceString(args.namespace);
      const documentPath = documentPathForResult(result);
      const defaultSubpath =
        namespaceSlug && documentPath
          ? path.join('.agor', 'kb', namespaceSlug, documentPath)
          : null;
      const requestedSubpath = coerceString(args.subpath) ?? defaultSubpath;
      if (!requestedSubpath) {
        throw new Error('subpath is required when the document namespace/path cannot be inferred');
      }
      const branchRepo = new BranchRepository(ctx.db);
      const workspace = await resolveBranchWorkspacePath({
        branchRepo,
        branchId: (await resolveBranchId(ctx, coerceString(args.branchId)!)) as BranchID,
        subpath: requestedSubpath,
        userId: ctx.userId,
        userRole: ctx.authenticatedUser.role as UserRole,
        requiredPermission: 'session',
      });
      const sidecarWorkspace = await resolveBranchWorkspacePath({
        branchRepo,
        branchId: workspace.branchId,
        subpath: materializationSidecarSubpath(workspace.relative),
        userId: ctx.userId,
        userRole: ctx.authenticatedUser.role as UserRole,
        requiredPermission: 'session',
      });
      const sidecarPath = sidecarWorkspace.canonical;
      if (!args.overwrite && (fs.existsSync(workspace.absolute) || fs.existsSync(sidecarPath))) {
        throw new Error(
          `Destination already exists: ${workspace.relative} (pass overwrite=true to replace)`
        );
      }
      await mkdir(path.dirname(workspace.absolute), { recursive: true });
      await writeFile(workspace.absolute, content, 'utf-8');
      const doc = (result.document ?? result) as Record<string, unknown>;
      const sidecar = {
        $schema: 'https://agor.live/schemas/kb-materialization/2026-06-06.json',
        document_id: doc.document_id,
        uri: doc.uri,
        namespace: namespaceSlug,
        path: documentPath,
        version_id: result.current_version?.version_id ?? null,
        version_number: result.current_version?.version_number ?? null,
        content_sha256: result.current_version?.content_sha256 ?? null,
        materialized_at: new Date().toISOString(),
        materialized_by: ctx.userId,
      };
      await writeKnowledgeMaterializationSidecar(sidecarPath, sidecar);
      return textResult(
        enrichWithReferenceUri({
          document: doc,
          version: versionToken(result.current_version),
          branchId: workspace.branchId,
          subpath: workspace.relative,
          destinationPath: workspace.absolute,
          sidecarPath,
          bytesWritten: Buffer.byteLength(content, 'utf-8'),
          instructions:
            'Edit the markdown file, then call agor_kb_publish_from_worktree with the same branchId/subpath. The sidecar preserves the source document and expected version.',
        })
      );
    }
  );

  server.registerTool(
    'agor_kb_publish_from_worktree',
    {
      description:
        'Publish a markdown file from a branch worktree into Knowledge. Requires branchId + branch-relative subpath and branch session permission. If a .agor-kb sidecar exists, it supplies documentId and expectedVersion; otherwise provide documentId or namespace + path. Updating an existing document creates one immutable KB version.',
      inputSchema: z.object({
        branchId: mcpRequiredId('branchId', 'Source branch/worktree'),
        subpath: mcpRequiredString('subpath', 'Branch-relative source markdown file path'),
        documentId: mcpOptionalId('documentId', 'Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString(
          'namespace',
          'Namespace/space slug. Required with path when creating without sidecar.'
        ),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path. Required with namespace when creating without sidecar.'
        ),
        expectedVersion: mcpOptionalVersionToken(
          'expectedVersion',
          'Expected current version number or ID. Defaults to sidecar version when present.'
        ),
        dryRun: z.boolean().optional().describe('Preview without creating/updating a KB version.'),
        createNamespace: z
          .boolean()
          .optional()
          .describe('Create namespace if missing when creating a new doc (default: false).'),
        title: mcpOptionalString('title', 'Optional title for newly-created documents'),
        firstLineIsTitle: z
          .boolean()
          .optional()
          .describe('Derive title from first markdown heading for newly-created docs.'),
        kind: KnowledgeDocumentKindSchema.optional().describe(
          'Document kind for newly-created docs'
        ),
        visibility: KnowledgeVisibilitySchema.optional().describe(
          'Visibility for newly-created docs'
        ),
        status: KnowledgeDocumentStatusSchema.optional().describe('Lifecycle status'),
        editPolicy: KnowledgeEditPolicySchema.optional().describe('Edit policy'),
        changeSummary: mcpOptionalString('changeSummary', 'Version history change summary'),
      }),
    },
    async (args) => {
      const branchRepo = new BranchRepository(ctx.db);
      const workspace = await resolveBranchWorkspacePath({
        branchRepo,
        branchId: (await resolveBranchId(ctx, coerceString(args.branchId)!)) as BranchID,
        subpath: coerceString(args.subpath),
        userId: ctx.userId,
        userRole: ctx.authenticatedUser.role as UserRole,
        requiredPermission: 'session',
      });
      if (!fs.existsSync(workspace.absolute)) {
        throw new Error(`File not found in branch worktree: ${workspace.relative}`);
      }
      const content = await readFile(workspace.absolute, 'utf-8');
      const sidecarWorkspace = await resolveBranchWorkspacePath({
        branchRepo,
        branchId: workspace.branchId,
        subpath: materializationSidecarSubpath(workspace.relative),
        userId: ctx.userId,
        userRole: ctx.authenticatedUser.role as UserRole,
        requiredPermission: 'session',
      });
      const sidecarPath = sidecarWorkspace.canonical;
      let sidecar: Record<string, unknown> = {};
      if (fs.existsSync(sidecarPath)) {
        try {
          sidecar = JSON.parse(await readFile(sidecarPath, 'utf-8')) as Record<string, unknown>;
        } catch (error) {
          throw new Error(
            `Failed to parse KB sidecar ${path.relative(workspace.branchRoot, sidecarPath)}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      const documentId = coerceString(args.documentId) ?? coerceString(sidecar.document_id);
      const uri = coerceString(args.uri) ?? coerceString(sidecar.uri);
      const parsedUri = parseKnowledgeUri(uri);
      const namespace =
        coerceString(args.namespace) ??
        parsedUri?.namespace_slug ??
        coerceString(sidecar.namespace);
      const docPath = coerceString(args.path) ?? parsedUri?.path ?? coerceString(sidecar.path);
      const expectedVersion =
        args.expectedVersion ??
        coerceString(sidecar.version_id) ??
        (typeof sidecar.version_number === 'number' ? sidecar.version_number : undefined);

      const documentService = getOptionalService(ctx, 'kb/documents');
      if (!documentService) {
        return knowledgeNotImplementedResult('agor_kb_publish_from_worktree', ['kb/documents']);
      }

      const dryRun = args.dryRun === true;
      let existing: HydratedKnowledgeDocumentResult | null = null;
      try {
        existing = await fetchKnowledgeDocument(ctx, {
          documentId,
          uri,
          namespace,
          path: docPath,
          includeContent: true,
        });
      } catch (error) {
        if (documentId || uri || !isNotFoundError(error)) throw error;
      }

      if (existing?.current_version) {
        if (!expectedVersion && !dryRun) {
          throw new Error('expectedVersion is required to publish over an existing KB document');
        }
        const baseContent = typeof existing.content === 'string' ? existing.content : '';
        const lineCount = splitMarkdownLines(baseContent).length;
        const editService = getOptionalService(ctx, 'kb/document-edits');
        if (!editService?.create) {
          return knowledgeNotImplementedResult('agor_kb_publish_from_worktree', [
            'kb/document-edits.create',
          ]);
        }
        const editResult = (await editService.create(
          {
            documentId: coerceString((existing.document ?? existing).document_id) ?? documentId,
            expectedVersion: expectedVersion ?? existing.current_version.version_number,
            dryRun,
            changeSummary: coerceString(args.changeSummary) ?? `Publish from ${workspace.relative}`,
            ops: [
              {
                type: 'replace_line_range',
                startLine: 1,
                endLine: lineCount,
                replacement: content,
                expectedText: baseContent,
              },
            ],
            returnContent: dryRun ? 'full' : 'none',
          },
          mcpParams(ctx)
        )) as Record<string, unknown>;
        const newVersion = editResult.newVersion as Record<string, unknown> | undefined;
        const editedDocument = editResult.document as Record<string, unknown> | undefined;
        if (!dryRun && newVersion) {
          await writeKnowledgeMaterializationSidecar(sidecarPath, {
            ...sidecar,
            $schema:
              sidecar.$schema ?? 'https://agor.live/schemas/kb-materialization/2026-06-06.json',
            document_id: editedDocument?.document_id ?? sidecar.document_id ?? documentId,
            uri: editedDocument?.uri ?? sidecar.uri ?? uri,
            namespace,
            path: docPath,
            version_id: newVersion.version_id,
            version_number: newVersion.version_number,
            content_sha256: newVersion.content_sha256 ?? null,
            materialized_at: sidecar.materialized_at ?? null,
            materialized_by: sidecar.materialized_by ?? null,
            published_at: new Date().toISOString(),
            published_by: ctx.userId,
          });
        }
        return textResult({
          ...editResult,
          sidecarUpdated: !dryRun && Boolean(newVersion),
          sidecarPath: !dryRun && newVersion ? sidecarPath : undefined,
        });
      }

      if (!namespace || !docPath) {
        throw new Error(
          'No existing document or sidecar found. Provide namespace + path to create a new KB document.'
        );
      }
      if (dryRun) {
        return textResult({
          dryRun: true,
          create: true,
          namespace,
          path: docPath,
          branchId: workspace.branchId,
          subpath: workspace.relative,
          content,
          diff: createTwoFilesPatch('empty', workspace.relative, '', content, '', ''),
        });
      }

      const customResult = await callCustomMethod(
        documentService,
        'putDocument',
        {
          namespace_slug: namespace,
          path: docPath,
          content_text: content,
          create_namespace: args.createNamespace === true,
          title: coerceString(args.title),
          first_line_is_title: args.firstLineIsTitle,
          kind: (args.kind as KnowledgeDocumentKind | undefined) ?? 'doc',
          visibility: args.visibility as KnowledgeVisibility | undefined,
          status: args.status as KnowledgeDocumentStatus | undefined,
          edit_policy: args.editPolicy as KnowledgeEditPolicy | undefined,
          change_summary: coerceString(args.changeSummary) ?? `Publish from ${workspace.relative}`,
        },
        mcpParams(ctx)
      );
      if (customResult !== undefined) {
        const hydrated = await fetchKnowledgeDocument(ctx, {
          namespace,
          path: docPath,
          includeContent: true,
        });
        const doc = (hydrated.document ?? hydrated) as Record<string, unknown>;
        await writeKnowledgeMaterializationSidecar(sidecarPath, {
          ...sidecar,
          $schema:
            sidecar.$schema ?? 'https://agor.live/schemas/kb-materialization/2026-06-06.json',
          document_id: doc.document_id,
          uri: doc.uri,
          namespace,
          path: docPath,
          version_id: hydrated.current_version?.version_id ?? null,
          version_number: hydrated.current_version?.version_number ?? null,
          content_sha256: hydrated.current_version?.content_sha256 ?? null,
          materialized_at: sidecar.materialized_at ?? null,
          materialized_by: sidecar.materialized_by ?? null,
          published_at: new Date().toISOString(),
          published_by: ctx.userId,
        });
        return textResult(
          enrichWithReferenceUri({
            result: customResult,
            sidecarUpdated: true,
            sidecarPath,
            version: versionToken(hydrated.current_version),
          })
        );
      }
      return knowledgeNotImplementedResult('agor_kb_publish_from_worktree', [
        'kb/documents.putDocument',
      ]);
    }
  );

  server.registerTool(
    'agor_kb_history',
    {
      description: 'List version history for a Knowledge document.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: mcpOptionalId('documentId', 'Knowledge document'),
        uri: mcpOptionalNonBlankString('uri', 'Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: mcpOptionalNonBlankString('namespace', 'Namespace/space slug; use with path'),
        path: mcpOptionalNonBlankString(
          'path',
          'Document path inside namespace; use with namespace'
        ),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include content text for each version (default: false)'),
        limit: mcpLimit(20).describe('Maximum number of versions (default: 20)'),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/versions');
      if (!service) return knowledgeNotImplementedResult('agor_kb_history', ['kb/versions']);

      const query: Record<string, unknown> = {
        include_content: args.includeContent === true,
      };
      if (args.documentId) query.document_id = coerceString(args.documentId);
      const uri = coerceString(args.uri);
      if (uri?.startsWith(KNOWLEDGE_DOCUMENT_URI_PREFIX)) {
        const idFromUri = uri.slice(KNOWLEDGE_DOCUMENT_URI_PREFIX.length);
        if (service.get)
          return textResult(
            enrichWithReferenceUri(await service.get(idFromUri, mcpParams(ctx, query)))
          );
        return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents.get']);
      }
      if (uri) query.uri = uri;
      const parsedUri = parseKnowledgeUri(uri);
      const namespace = coerceString(args.namespace) ?? parsedUri?.namespace_slug;
      const path = coerceString(args.path) ?? parsedUri?.path;
      if (namespace) query.namespace_slug = namespace;
      if (path) query.path = path;
      if (args.limit) query.$limit = args.limit;
      if (!query.document_id && (!query.namespace_slug || !query.path)) {
        throw new Error(
          'Provide documentId, a valid agor://kb/<namespace>/<path> uri, or namespace + path.'
        );
      }

      if (service.find) return textResult(await service.find(mcpParams(ctx, query)));
      return knowledgeNotImplementedResult('agor_kb_history', ['kb/versions.find']);
    }
  );

  server.registerTool(
    'agor_kb_link',
    {
      description:
        'Create or update a directed Knowledge graph edge between two Knowledge/Core/External nodes. The backend should upsert by source + target + edgeType.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        source: KnowledgeNodeRefSchema,
        target: KnowledgeNodeRefSchema,
        edgeType: KnowledgeGraphEdgeTypeSchema.describe('Relationship type'),
        confidence: z
          .number({
            error: 'confidence must be a number between 0 and 1 when provided.',
          })
          .min(0, 'confidence must be greater than or equal to 0.')
          .max(1, 'confidence must be less than or equal to 1.')
          .optional()
          .describe('Optional confidence score from 0 to 1'),
        properties: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Edge metadata/properties'),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/graph');
      if (!service) return knowledgeNotImplementedResult('agor_kb_link', ['kb/graph']);

      const data = {
        source: coerceJsonRecord(args.source),
        target: coerceJsonRecord(args.target),
        edge_type: args.edgeType as KnowledgeGraphEdgeType,
        confidence: optionalNumber(args.confidence),
        properties: coerceJsonRecord(args.properties),
      };

      const customResult = await callCustomMethod(service, 'link', data, mcpParams(ctx));
      if (customResult !== undefined) return textResult(customResult);

      if (service.create) return textResult(await service.create(data, mcpParams(ctx)));
      return knowledgeNotImplementedResult('agor_kb_link', ['kb/graph.link', 'kb/graph.create']);
    }
  );

  server.registerTool(
    'agor_kb_graph_neighbors',
    {
      description:
        'Fetch neighboring Knowledge graph nodes and edges around a node/document/core object reference.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        node: KnowledgeNodeRefSchema,
        direction: z
          .enum(['out', 'in', 'both'])
          .optional()
          .describe('Traversal direction (default: both)'),
        edgeTypes: z
          .array(KnowledgeGraphEdgeTypeSchema)
          .optional()
          .describe('Optional relationship types to include'),
        nodeTypes: z
          .array(KnowledgeGraphNodeTypeSchema)
          .optional()
          .describe('Optional neighbor node types to include'),
        depth: mcpOptionalPositiveInt('depth', 'Traversal depth (default: 1; V1 may cap at 2)'),
        limit: mcpLimit(50).describe('Maximum neighbors/edges to return (default: 50)'),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived graph nodes and edges (default: false)'),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/graph');
      if (!service) return knowledgeNotImplementedResult('agor_kb_graph_neighbors', ['kb/graph']);

      const query: Record<string, unknown> = {
        node: coerceJsonRecord(args.node),
        direction: args.direction ?? 'both',
      };
      const edgeTypes = optionalStringArray(args.edgeTypes) as KnowledgeGraphEdgeType[] | undefined;
      const nodeTypes = optionalStringArray(args.nodeTypes) as KnowledgeGraphNodeType[] | undefined;
      if (edgeTypes) query.edge_types = edgeTypes;
      if (nodeTypes) query.node_types = nodeTypes;
      if (args.depth) query.depth = args.depth;
      if (args.limit) query.limit = args.limit;
      if (args.includeArchived) query.include_archived = true;

      const customResult = await callCustomMethod(service, 'neighbors', query, mcpParams(ctx));
      if (customResult !== undefined) return textResult(customResult);

      if (service.find) return textResult(await service.find(mcpParams(ctx, query)));
      return knowledgeNotImplementedResult('agor_kb_graph_neighbors', [
        'kb/graph.neighbors',
        'kb/graph.find',
      ]);
    }
  );
}
