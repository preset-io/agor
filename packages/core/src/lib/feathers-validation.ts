/**
 * FeathersJS Query Validation
 *
 * Uses TypeBox + Ajv for schema-based query validation.
 * Prevents NoSQL injection by validating query structure and values.
 */

import { Ajv } from '@feathersjs/schema';
import type { TObject, TProperties } from '@feathersjs/typebox';
import { getValidator, Type } from '@feathersjs/typebox';
import { AGENTIC_TOOL_NAMES, PERSISTED_AGENTIC_TOOL_NAMES } from '../types/agentic-tool';
import { MCP_CATALOG_CATEGORIES, MCP_CATALOG_PROBED_AUTH_TYPES } from '../types/mcp-catalog';

/**
 * Query validator with type coercion enabled
 * This automatically converts string query params to their correct types
 */
export const queryValidator = new Ajv({
  coerceTypes: true, // Auto-convert "123" -> 123, "true" -> true, etc.
  removeAdditional: 'all', // Remove unknown properties (defense against injection)
  useDefaults: true,
});

/**
 * Common TypeBox schemas for reusable field types
 */
export const CommonSchemas = {
  // UUIDs (full or short format)
  uuid: Type.String({
    pattern: '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{8}$',
  }),

  // Session status enum
  sessionStatus: Type.Union([
    Type.Literal('idle'),
    Type.Literal('running'),
    Type.Literal('stopping'),
    Type.Literal('awaiting_permission'),
    Type.Literal('awaiting_input'),
    Type.Literal('timed_out'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ]),

  // Active agentic tool enum
  agenticTool: Type.Union(AGENTIC_TOOL_NAMES.map((tool) => Type.Literal(tool))),

  // Session query compatibility: historical rows keep their removed tool id.
  persistedAgenticTool: Type.Union(PERSISTED_AGENTIC_TOOL_NAMES.map((tool) => Type.Literal(tool))),

  // Permission mode enum - union of all native SDK modes
  permissionMode: Type.Union([
    // Claude Code native modes
    Type.Literal('default'),
    Type.Literal('acceptEdits'),
    Type.Literal('bypassPermissions'),
    Type.Literal('plan'),
    Type.Literal('dontAsk'),
    // Gemini native modes
    Type.Literal('autoEdit'),
    Type.Literal('yolo'),
    // Codex native modes
    Type.Literal('ask'),
    Type.Literal('auto'),
    Type.Literal('on-failure'),
    Type.Literal('allow-all'),
  ]),

  // Timestamps
  timestamp: Type.Integer({ minimum: 0 }),

  // Boolean
  boolean: Type.Boolean(),
};

/**
 * Helper to create query schemas with common Feathers operators
 */
export function createQuerySchema<T extends TProperties>(properties: TObject<T>) {
  return Type.Intersect(
    [
      properties,
      Type.Object({
        $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
        $skip: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
        $sort: Type.Optional(
          Type.Record(Type.String(), Type.Union([Type.Literal(1), Type.Literal(-1)]))
        ),
        $select: Type.Optional(Type.Array(Type.String())),
      }),
    ],
    { additionalProperties: false }
  );
}

/**
 * Session query schema
 */
export const sessionQuerySchema = createQuerySchema(
  Type.Object({
    session_id: Type.Optional(CommonSchemas.uuid),
    status: Type.Optional(CommonSchemas.sessionStatus),
    agentic_tool: Type.Optional(CommonSchemas.persistedAgenticTool),
    board_id: Type.Optional(CommonSchemas.uuid),
    branch_id: Type.Optional(CommonSchemas.uuid),
    parent_session_id: Type.Optional(CommonSchemas.uuid),
    forked_from_session_id: Type.Optional(CommonSchemas.uuid),
    schedule_id: Type.Optional(CommonSchemas.uuid),
    created_by: Type.Optional(CommonSchemas.uuid),
    archived: Type.Optional(CommonSchemas.boolean),
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
    // Marks a `remove` as the delete half of a "switch tool" swap so the
    // service can refuse it if a task landed on the session mid-swap. Declared
    // here so the query validator (`removeAdditional: 'all'`) doesn't strip it
    // before the service's guard sees it.
    _swapReplace: Type.Optional(CommonSchemas.boolean),
  })
);

/**
 * Task query schema
 */
export const taskQuerySchema = createQuerySchema(
  Type.Object({
    task_id: Type.Optional(CommonSchemas.uuid),
    session_id: Type.Optional(CommonSchemas.uuid),
    status: Type.Optional(
      Type.Union([
        Type.Literal('queued'),
        Type.Literal('created'),
        Type.Literal('dispatching'),
        Type.Literal('running'),
        Type.Literal('stopping'),
        Type.Literal('awaiting_permission'),
        Type.Literal('awaiting_input'),
        Type.Literal('timed_out'),
        Type.Literal('completed'),
        Type.Literal('failed'),
        Type.Literal('stopped'),
      ])
    ),
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * Branch query schema
 */
export const branchQuerySchema = createQuerySchema(
  Type.Object({
    branch_id: Type.Optional(CommonSchemas.uuid),
    repo_id: Type.Optional(CommonSchemas.uuid),
    board_id: Type.Optional(CommonSchemas.uuid),
    zone_id: Type.Optional(Type.String({ maxLength: 255 })),
    name: Type.Optional(Type.String({ maxLength: 255 })),
    archived: Type.Optional(CommonSchemas.boolean),
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * Board query schema
 */
export const boardQuerySchema = createQuerySchema(
  Type.Object({
    board_id: Type.Optional(CommonSchemas.uuid),
    name: Type.Optional(Type.String({ maxLength: 255 })),
    slug: Type.Optional(Type.String({ maxLength: 255 })),
    created_by: Type.Optional(CommonSchemas.uuid),
    archived: Type.Optional(CommonSchemas.boolean),
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
    // List-only projection flag: when true, the boards service omits the heavy
    // `data.objects` / `data.custom_css` annotations from each row so a workspace
    // load doesn't ship every board's canvas annotations to paint one board's.
    // `boards.get(id)` is unaffected and always returns the full board.
    lean: Type.Optional(CommonSchemas.boolean),
  })
);

/**
 * User query schema
 */
export const userQuerySchema = createQuerySchema(
  Type.Object({
    user_id: Type.Optional(CommonSchemas.uuid),
    email: Type.Optional(Type.String({ maxLength: 255 })),
    search: Type.Optional(Type.String({ maxLength: 255 })),
    query: Type.Optional(Type.String({ maxLength: 255 })),
    q: Type.Optional(Type.String({ maxLength: 255 })),
    limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    skip: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    role: Type.Optional(
      Type.Union([
        Type.Literal('superadmin'),
        Type.Literal('admin'),
        Type.Literal('member'),
        Type.Literal('viewer'),
        Type.Literal('owner'), // Deprecated alias for superadmin (backwards compat)
      ])
    ),
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * Board object query schema
 */
export const boardObjectQuerySchema = createQuerySchema(
  Type.Object({
    board_id: Type.Optional(CommonSchemas.uuid),
    branch_id: Type.Optional(CommonSchemas.uuid),
    card_id: Type.Optional(CommonSchemas.uuid),
    zone_id: Type.Optional(Type.String()),
    entity_type: Type.Optional(Type.Union([Type.Literal('branch'), Type.Literal('card')])),
    created_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * Board comment query schema
 */
export const boardCommentQuerySchema = createQuerySchema(
  Type.Object({
    board_id: Type.Optional(CommonSchemas.uuid),
    created_by: Type.Optional(CommonSchemas.uuid),
    created_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * Repo query schema
 */
export const repoQuerySchema = createQuerySchema(
  Type.Object({
    repo_id: Type.Optional(CommonSchemas.uuid),
    slug: Type.Optional(Type.String({ maxLength: 255 })),
    cleanup: Type.Optional(CommonSchemas.boolean), // For delete: true = delete filesystem too
    created_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * MCP server query schema
 */
export const mcpServerQuerySchema = createQuerySchema(
  Type.Object({
    mcp_server_id: Type.Optional(CommonSchemas.uuid),
    server_id: Type.Optional(CommonSchemas.uuid), // Legacy alias
    scope: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('session')])),
    scopeId: Type.Optional(Type.String()), // scope_id for session-scoped servers
    transport: Type.Optional(
      Type.Union([Type.Literal('stdio'), Type.Literal('http'), Type.Literal('sse')])
    ),
    enabled: Type.Optional(Type.Boolean()),
    source: Type.Optional(
      Type.Union([Type.Literal('user'), Type.Literal('imported'), Type.Literal('agor')])
    ),
    ownerless: Type.Optional(CommonSchemas.boolean),
    // Executor/session-token callers pass this so hooks can inject the
    // task creator's per-user OAuth token instead of the session owner's.
    forUserId: Type.Optional(CommonSchemas.uuid),
    // Narrows a listing to shared servers plus one user's private ones.
    // Trusted callers set it; on an external member request the service hooks
    // overwrite whatever arrived with the caller's own id.
    usableByUserId: Type.Optional(CommonSchemas.uuid),
    created_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * MCP catalog query schema
 *
 * The catalog's filters reach SQL, so validation is also the injection
 * boundary: `removeAdditional: 'all'` drops anything not listed here before a
 * value can be interpolated into a LIKE pattern or an ORDER BY.
 */
export const mcpCatalogQuerySchema = Type.Intersect(
  [
    Type.Object({
      catalog_entry_id: Type.Optional(CommonSchemas.uuid),
      name: Type.Optional(Type.String({ maxLength: 512 })),
      search: Type.Optional(Type.String({ maxLength: 128 })),
      category: Type.Optional(
        Type.Union(MCP_CATALOG_CATEGORIES.map((category) => Type.Literal(category)))
      ),
      capability: Type.Optional(Type.String({ maxLength: 64 })),
      verified: Type.Optional(Type.Boolean()),
      curated: Type.Optional(Type.Boolean()),
      has_remote: Type.Optional(Type.Boolean()),
      probed_auth_type: Type.Optional(
        Type.Union(MCP_CATALOG_PROBED_AUTH_TYPES.map((value) => Type.Literal(value)))
      ),
      // Asking for a lifecycle state by name opts out of the default exclusion
      // of withdrawn servers, so it has to survive validation rather than be
      // stripped as an unknown key.
      registry_status: Type.Optional(Type.String({ maxLength: 32 })),
      sort: Type.Optional(
        Type.Union([
          Type.Literal('popularity'),
          Type.Literal('name'),
          Type.Literal('recently_updated'),
          Type.Literal('relevance'),
        ])
      ),
    }),
    // Deliberately not `createQuerySchema`: that shape also advertises `$sort`
    // and `$select`, and this service honours neither. Ordering is the domain
    // `sort` above, which maps onto indexed SQL; a caller-supplied `$sort` over
    // arbitrary columns would silently do nothing. Listing only what is
    // implemented keeps the schema an accurate contract rather than a wish.
    Type.Object({
      // Mirrors MCP_CATALOG_PAGINATION.MAX_LIMIT in the catalog service. Every
      // row carries curation copy and registry metadata, so a page bound the
      // shared schema would allow is a multi-megabyte response.
      $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      $skip: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
    }),
  ],
  { additionalProperties: false }
);

/**
 * Create validators for each schema
 */
export const sessionQueryValidator = getValidator(sessionQuerySchema, queryValidator);
export const taskQueryValidator = getValidator(taskQuerySchema, queryValidator);
export const branchQueryValidator = getValidator(branchQuerySchema, queryValidator);
export const boardQueryValidator = getValidator(boardQuerySchema, queryValidator);
export const userQueryValidator = getValidator(userQuerySchema, queryValidator);
export const boardObjectQueryValidator = getValidator(boardObjectQuerySchema, queryValidator);
export const boardCommentQueryValidator = getValidator(boardCommentQuerySchema, queryValidator);
export const repoQueryValidator = getValidator(repoQuerySchema, queryValidator);
export const mcpServerQueryValidator = getValidator(mcpServerQuerySchema, queryValidator);
export const mcpCatalogQueryValidator = getValidator(mcpCatalogQuerySchema, queryValidator);

/**
 * Wrap validateQuery to produce a FeathersJS-compatible hook function.
 *
 * validateQuery (from @feathersjs/schema) returns `Promise<any>` but FeathersJS
 * hooks arrays expect `(context: HookContext) => Promise<HookContext | void>`.
 * The types are runtime-compatible; this wrapper bridges the TypeScript gap.
 */
export function typedValidateQuery(
  validator: Parameters<typeof validateQueryFn>[0]
): (context: unknown) => Promise<void> {
  return validateQueryFn(validator) as unknown as (context: unknown) => Promise<void>;
}

// Re-export validateQuery for direct usage
import { validateQuery as validateQueryFn } from '@feathersjs/schema';
