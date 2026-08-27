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
 * Message queries reject unknown fields instead of silently removing them.
 * Silently turning a misspelled filter into a broad transcript query is both
 * surprising and potentially expensive.
 */
export const strictQueryValidator = new Ajv({
  coerceTypes: true,
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
const taskSortDirection = Type.Union([Type.Literal(1), Type.Literal(-1)]);
export const taskQuerySchema = Type.Intersect(
  [
    Type.Object({
      task_id: Type.Optional(
        Type.Union([
          CommonSchemas.uuid,
          Type.Object(
            {
              $gt: Type.Optional(CommonSchemas.uuid),
              $lte: CommonSchemas.uuid,
            },
            { additionalProperties: false }
          ),
        ])
      ),
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
      created_by: Type.Optional(CommonSchemas.uuid),
    }),
    Type.Object({
      $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
      // Retained for compatible exact-Session callers. The shared client now
      // hydrates Tasks with a Task-ID high-water keyset instead of OFFSET.
      $skip: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
      $sort: Type.Optional(
        Type.Partial(
          Type.Object(
            {
              task_id: taskSortDirection,
              session_id: taskSortDirection,
              status: taskSortDirection,
              created_at: taskSortDirection,
              created_by: taskSortDirection,
            },
            { additionalProperties: false }
          )
        )
      ),
      $select: Type.Optional(Type.Array(Type.String())),
    }),
  ],
  { additionalProperties: false }
);

const messageTypeSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('system'),
  Type.Literal('file-history-snapshot'),
  Type.Literal('permission_request'),
  Type.Literal('input_request'),
  Type.Literal('daemon_restart'),
  Type.Literal('daemon_crash'),
  Type.Literal('widget_request'),
]);
const messageRoleSchema = Type.Union([
  Type.Literal('user'),
  Type.Literal('assistant'),
  Type.Literal('system'),
]);
const sortDirectionSchema = Type.Union([Type.Literal(1), Type.Literal(-1)]);
const messageSelectableFieldSchema = Type.Union(
  [
    'message_id',
    'session_id',
    'task_id',
    'type',
    'role',
    'index',
    'timestamp',
    'content_preview',
    'content',
    'tool_uses',
    'parent_tool_use_id',
    'metadata',
  ].map((field) => Type.Literal(field))
);

/**
 * Message list contract. `$limit` is accepted above the service ceiling so
 * Feathers can clamp it consistently. Exact hydration uses the bounded
 * message_id range above; `$skip` remains for compatible exact-transcript
 * callers, while MessagesService rejects broad deep offsets.
 */
export const messageQuerySchema = Type.Object(
  {
    message_id: Type.Optional(
      Type.Union([
        CommonSchemas.uuid,
        Type.Object(
          {
            $gt: Type.Optional(CommonSchemas.uuid),
            $lte: CommonSchemas.uuid,
          },
          { additionalProperties: false }
        ),
      ])
    ),
    session_id: Type.Optional(
      Type.Union([
        CommonSchemas.uuid,
        Type.Object(
          { $in: Type.Array(CommonSchemas.uuid, { maxItems: 1_000 }) },
          { additionalProperties: false }
        ),
      ])
    ),
    task_id: Type.Optional(CommonSchemas.uuid),
    type: Type.Optional(messageTypeSchema),
    role: Type.Optional(messageRoleSchema),
    $limit: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    $skip: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    $sort: Type.Optional(
      Type.Object(
        {
          message_id: Type.Optional(sortDirectionSchema),
          session_id: Type.Optional(sortDirectionSchema),
          type: Type.Optional(sortDirectionSchema),
          role: Type.Optional(sortDirectionSchema),
          index: Type.Optional(sortDirectionSchema),
          timestamp: Type.Optional(sortDirectionSchema),
          created_at: Type.Optional(sortDirectionSchema),
        },
        { additionalProperties: false }
      )
    ),
    $select: Type.Optional(
      Type.Array(messageSelectableFieldSchema, { maxItems: 12, uniqueItems: true })
    ),
  },
  { additionalProperties: false }
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
      Type.Union([
        Type.Literal('user'),
        Type.Literal('imported'),
        Type.Literal('agor'),
        Type.Literal('catalog'),
      ])
    ),
    ownerless: Type.Optional(CommonSchemas.boolean),
    // Executor/session-token callers pass this so hooks can inject the
    // task creator's per-user OAuth token instead of the session owner's.
    // Narrows a listing to shared servers plus one user's private ones.
    // Trusted callers set it; on an external member request the service hooks
    // overwrite whatever arrived with the caller's own id.
    usableByUserId: Type.Optional(CommonSchemas.uuid),
    created_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * MCP catalog query schema: deliberately empty.
 *
 * `find` takes no parameters — it returns the whole catalog and the browser
 * narrows it — so there is nothing here to name. The schema stays registered
 * rather than being deleted because `removeAdditional: 'all'` is what makes
 * that contract enforced instead of merely documented: a `search=` or `$skip=`
 * from a tab left open across the deploy that removed them is stripped here, so
 * it cannot reach `find` and be quietly ignored one layer further in.
 *
 * Stripping rather than rejecting is the deliberate choice: the stale tab gets
 * the full catalog and renders it, and recovers on reload. A 400 would blank
 * the Marketplace for anyone mid-deploy.
 */
export const mcpCatalogQuerySchema = Type.Object({}, { additionalProperties: false });

/**
 * Create validators for each schema
 */
export const sessionQueryValidator = getValidator(sessionQuerySchema, queryValidator);
export const taskQueryValidator = getValidator(taskQuerySchema, strictQueryValidator);
export const messageQueryValidator = getValidator(messageQuerySchema, strictQueryValidator);
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
