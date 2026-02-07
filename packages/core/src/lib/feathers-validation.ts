/**
 * FeathersJS Query Validation
 *
 * Uses TypeBox + Ajv for schema-based query validation.
 * Prevents NoSQL injection by validating query structure and values.
 */

import { Ajv } from '@feathersjs/schema';
import type { TObject, TProperties } from '@feathersjs/typebox';
import { getValidator, Type } from '@feathersjs/typebox';

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
    Type.Literal('awaiting_permission'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ]),

  // Agentic tool enum
  agenticTool: Type.Union([
    Type.Literal('claude-code'),
    Type.Literal('codex'),
    Type.Literal('gemini'),
    Type.Literal('opencode'),
  ]),

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
    agentic_tool: Type.Optional(CommonSchemas.agenticTool),
    board_id: Type.Optional(CommonSchemas.uuid),
    worktree_id: Type.Optional(CommonSchemas.uuid),
    parent_session_id: Type.Optional(CommonSchemas.uuid),
    forked_from_session_id: Type.Optional(CommonSchemas.uuid),
    created_by: Type.Optional(CommonSchemas.uuid),
    archived: Type.Optional(CommonSchemas.boolean),
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
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
        Type.Literal('pending'),
        Type.Literal('running'),
        Type.Literal('awaiting_permission'),
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
 * Worktree query schema
 */
export const worktreeQuerySchema = createQuerySchema(
  Type.Object({
    worktree_id: Type.Optional(CommonSchemas.uuid),
    repo_id: Type.Optional(CommonSchemas.uuid),
    board_id: Type.Optional(CommonSchemas.uuid),
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
    created_at: Type.Optional(CommonSchemas.timestamp),
    updated_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * User query schema
 */
export const userQuerySchema = createQuerySchema(
  Type.Object({
    user_id: Type.Optional(CommonSchemas.uuid),
    email: Type.Optional(Type.String({ maxLength: 255 })),
    role: Type.Optional(
      Type.Union([
        Type.Literal('owner'),
        Type.Literal('admin'),
        Type.Literal('member'),
        Type.Literal('viewer'),
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
    worktree_id: Type.Optional(CommonSchemas.uuid),
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
    created_at: Type.Optional(CommonSchemas.timestamp),
  })
);

/**
 * Create validators for each schema
 */
export const sessionQueryValidator = getValidator(sessionQuerySchema, queryValidator);
export const taskQueryValidator = getValidator(taskQuerySchema, queryValidator);
export const worktreeQueryValidator = getValidator(worktreeQuerySchema, queryValidator);
export const boardQueryValidator = getValidator(boardQuerySchema, queryValidator);
export const userQueryValidator = getValidator(userQuerySchema, queryValidator);
export const boardObjectQueryValidator = getValidator(boardObjectQuerySchema, queryValidator);
export const boardCommentQueryValidator = getValidator(boardCommentQuerySchema, queryValidator);
export const repoQueryValidator = getValidator(repoQuerySchema, queryValidator);
export const mcpServerQueryValidator = getValidator(mcpServerQuerySchema, queryValidator);
