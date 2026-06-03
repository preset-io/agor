import type {
  KnowledgeDocumentKind,
  KnowledgeEditPolicy,
  KnowledgeGraphEdgeType,
  KnowledgeGraphNodeType,
  KnowledgeVisibility,
} from '@agor/core/types';
import {
  KNOWLEDGE_DOCUMENT_KINDS,
  KNOWLEDGE_EDIT_POLICIES,
  KNOWLEDGE_GRAPH_EDGE_TYPES,
  KNOWLEDGE_GRAPH_NODE_TYPES,
  KNOWLEDGE_VISIBILITIES,
  parseKnowledgeUri,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { coerceJsonRecord, coerceString, textResult } from '../server.js';

const KnowledgeDocumentKindSchema = z.enum(KNOWLEDGE_DOCUMENT_KINDS);
const KnowledgeVisibilitySchema = z.enum(KNOWLEDGE_VISIBILITIES);
const KnowledgeEditPolicySchema = z.enum(KNOWLEDGE_EDIT_POLICIES);
const KnowledgeGraphNodeTypeSchema = z.enum(KNOWLEDGE_GRAPH_NODE_TYPES);
const KnowledgeGraphEdgeTypeSchema = z.enum(KNOWLEDGE_GRAPH_EDGE_TYPES);

const KnowledgeNodeRefSchema = z
  .object({
    nodeId: z.string().optional().describe('Knowledge graph node ID (UUIDv7 or short ID)'),
    uri: z
      .string()
      .optional()
      .describe('Canonical node/document URI, e.g. agor://kb/global/architecture.md'),
    nodeType: KnowledgeGraphNodeTypeSchema.optional().describe(
      'Node type to resolve or create when nodeId/uri is not enough.'
    ),
    documentId: z.string().optional().describe('Knowledge document ID (UUIDv7 or short ID)'),
    namespace: z.string().optional().describe('Knowledge namespace/space slug'),
    path: z.string().optional().describe('Document path inside namespace'),
    externalUri: z.string().optional().describe('External URL or URI for external nodes'),
    branchId: z.string().optional().describe('Branch ID (UUIDv7 or short ID)'),
    sessionId: z.string().optional().describe('Session ID (UUIDv7 or short ID)'),
    taskId: z.string().optional().describe('Task ID (UUIDv7 or short ID)'),
    messageId: z.string().optional().describe('Message ID (UUIDv7 or short ID)'),
    artifactId: z.string().optional().describe('Artifact ID (UUIDv7 or short ID)'),
    repoId: z.string().optional().describe('Repository ID (UUIDv7 or short ID)'),
    boardId: z.string().optional().describe('Board ID (UUIDv7 or short ID)'),
    userId: z.string().optional().describe('User ID (UUIDv7 or short ID)'),
    label: z.string().optional().describe('Optional label for newly-created graph nodes'),
  })
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

export function registerKnowledgeTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_kb_namespaces_list',
    {
      description: 'List Knowledge namespaces/spaces available to the current user.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        slug: z.string().optional().describe('Filter by namespace/space slug'),
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
        namespaceId: z.string().optional().describe('Existing namespace ID to update'),
        slug: z.string().describe('Namespace slug used in agor://kb/<slug>/... URIs'),
        displayName: z.string().optional().describe('Human-readable display name'),
        description: z.string().optional().describe('Namespace description'),
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
      if (!slug) throw new Error('slug is required');
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
        'Search Agor Knowledge documents. Supports namespace/path/kind filters now, with semantic/hybrid modes reserved for the future backend.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Search text. Use an empty string to browse with filters.'),
        namespace: z.string().optional().describe('Filter by namespace/space slug'),
        pathPrefix: z.string().optional().describe('Filter to document paths under this prefix'),
        kind: KnowledgeDocumentKindSchema.optional().describe('Filter by document kind'),
        visibility: KnowledgeVisibilitySchema.optional().describe('Filter by visibility'),
        includeArchived: z
          .boolean()
          .optional()
          .describe('Include archived documents (default: false)'),
        limit: z.number().optional().describe('Maximum number of results (default: 20)'),
        mode: z
          .enum(['text', 'semantic', 'hybrid'])
          .optional()
          .describe(
            'Search mode. V1 services should support text; semantic/hybrid may return a clear unsupported error.'
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
      if (args.limit) query.limit = args.limit;
      if (args.mode) query.mode = args.mode;

      if (service.find) return textResult(await service.find(mcpParams(ctx, query)));
      return knowledgeNotImplementedResult('agor_kb_search', ['kb/search.find']);
    }
  );

  server.registerTool(
    'agor_kb_get',
    {
      description:
        'Get a Knowledge document by documentId, canonical URI, or namespace + path. Returns the current version content by default when the backend supports includeContent.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: z.string().optional().describe('Knowledge document ID (UUIDv7 or short ID)'),
        uri: z.string().optional().describe('Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: z.string().optional().describe('Namespace/space slug; use with path'),
        path: z.string().optional().describe('Document path inside namespace; use with namespace'),
        version: z
          .union([z.number(), z.string()])
          .optional()
          .describe('Version number or version ID. Omit for current version.'),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include markdown/content text when supported (default: true)'),
        includeLinks: z
          .boolean()
          .optional()
          .describe('Include graph links/backlinks when supported'),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/documents');
      if (!service) return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents']);

      const includeContent = args.includeContent !== false;
      const query: Record<string, unknown> = { include_content: includeContent };
      if (args.version !== undefined) query.version = args.version;
      if (args.includeLinks !== undefined) query.include_links = args.includeLinks;

      const documentId = coerceString(args.documentId);
      if (documentId) {
        if (service.get) return textResult(await service.get(documentId, mcpParams(ctx, query)));
        return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents.get']);
      }

      const uri = coerceString(args.uri);
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
          version: args.version,
        },
        mcpParams(ctx)
      );
      if (customResult !== undefined) return textResult(customResult);

      if (service.find) return textResult(await service.find(mcpParams(ctx, query)));
      return knowledgeNotImplementedResult('agor_kb_get', ['kb/documents.find']);
    }
  );

  server.registerTool(
    'agor_kb_put',
    {
      description:
        'Create or update a markdown Knowledge document. This is an idempotent upsert keyed by documentId, URI, or namespace + path when the backend implements putDocument.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        documentId: z.string().optional().describe('Existing Knowledge document ID to update'),
        uri: z.string().optional().describe('Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: z
          .string()
          .optional()
          .describe('Namespace/space slug; required with path for new docs'),
        path: z
          .string()
          .optional()
          .describe('Document path inside namespace; required with namespace for new docs'),
        title: z
          .string()
          .optional()
          .describe('Human-readable title. Defaults can be derived from path.'),
        content: z.string().describe('Markdown content for the new version'),
        firstLineIsTitle: z
          .boolean()
          .optional()
          .describe(
            'When true, the first non-empty markdown line is treated as the document title and stored as metadata.title_from_content.'
          ),
        kind: KnowledgeDocumentKindSchema.optional().describe('Document kind (default: doc)'),
        visibility: KnowledgeVisibilitySchema.optional().describe(
          'Visibility (default: namespace default or public)'
        ),
        editPolicy: KnowledgeEditPolicySchema.optional().describe('Edit policy (default: owner)'),
        createNamespace: z
          .boolean()
          .optional()
          .describe('Create the namespace if it does not already exist (default: false).'),
        namespaceDisplayName: z
          .string()
          .optional()
          .describe('Display name to use when createNamespace is true.'),
        frontmatter: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Parsed frontmatter metadata'),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Document/version metadata'),
        changeSummary: z.string().optional().describe('Short summary for version history'),
        expectedVersion: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'Optional optimistic concurrency check: current version number or version ID expected by the caller'
          ),
      }),
    },
    async (args) => {
      const service = getOptionalService(ctx, 'kb/documents');
      if (!service) return knowledgeNotImplementedResult('agor_kb_put', ['kb/documents']);

      const content = typeof args.content === 'string' ? args.content : undefined;
      if (content === undefined) throw new Error('content is required');

      const uri = coerceString(args.uri);
      const parsedUri = parseKnowledgeUri(uri);
      const metadataInput = coerceJsonRecord(args.metadata) as Record<string, unknown> | undefined;
      const metadata = {
        ...(metadataInput ?? {}),
        ...(args.firstLineIsTitle === undefined
          ? {}
          : { title_from_content: args.firstLineIsTitle }),
      };

      const data = {
        document_id: coerceString(args.documentId),
        uri,
        namespace_slug: coerceString(args.namespace) ?? parsedUri?.namespace_slug,
        path: coerceString(args.path) ?? parsedUri?.path,
        title: coerceString(args.title),
        content_text: content,
        kind: (args.kind as KnowledgeDocumentKind | undefined) ?? 'doc',
        visibility: args.visibility as KnowledgeVisibility | undefined,
        edit_policy: args.editPolicy as KnowledgeEditPolicy | undefined,
        create_namespace: args.createNamespace === true,
        namespace_display_name: coerceString(args.namespaceDisplayName),
        frontmatter: coerceJsonRecord(args.frontmatter),
        metadata,
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
    'agor_kb_history',
    {
      description: 'List version history for a Knowledge document.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        documentId: z.string().optional().describe('Knowledge document ID (UUIDv7 or short ID)'),
        uri: z.string().optional().describe('Canonical URI, e.g. agor://kb/global/foo.md'),
        namespace: z.string().optional().describe('Namespace/space slug; use with path'),
        path: z.string().optional().describe('Document path inside namespace; use with namespace'),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include content text for each version (default: false)'),
        limit: z.number().optional().describe('Maximum number of versions (default: 20)'),
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
        confidence: z.number().optional().describe('Optional confidence score from 0 to 1'),
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
        depth: z.number().optional().describe('Traversal depth (default: 1; V1 may cap at 2)'),
        limit: z.number().optional().describe('Maximum neighbors/edges to return (default: 50)'),
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
