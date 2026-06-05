import { ROLES, type User } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

const USER_LIST_FIELDS = [
  'user_id',
  'email',
  'name',
  'emoji',
  'role',
  'unix_username',
  'created_at',
  'updated_at',
] as const;

const USER_QUERY_LIMIT_MAX = 10000;

type UserListField = (typeof USER_LIST_FIELDS)[number];
type UserListRow = Pick<User, UserListField>;
type UserFindField = 'email' | 'name' | 'unix_username';

function compactUser(user: User, fields?: UserListField[]): Partial<UserListRow> {
  const selectedFields = fields && fields.length > 0 ? fields : USER_LIST_FIELDS;
  return Object.fromEntries(
    selectedFields.map((field) => [field, user[field]])
  ) as Partial<UserListRow>;
}

function compactUsersResult(
  result: { total: number; limit: number; skip: number; data: User[] },
  fields?: UserListField[]
) {
  return {
    ...result,
    data: result.data.map((user) => compactUser(user, fields)),
  };
}

function includesCaseInsensitive(value: string | undefined, term: string): boolean {
  return value?.toLowerCase().includes(term.toLowerCase()) ?? false;
}

export function registerUserTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_users_list
  server.registerTool(
    'agor_users_list',
    {
      description:
        'List users in the system with pagination and optional case-insensitive search across name, email, and unix_username. Returns compact rows by default; pass lean:false for detailed user payloads.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .nonnegative()
          .max(USER_QUERY_LIMIT_MAX)
          .optional()
          .describe('Maximum number of results (default: 50)'),
        skip: z
          .number()
          .int()
          .nonnegative()
          .max(USER_QUERY_LIMIT_MAX)
          .optional()
          .describe('Number of results to skip'),
        offset: z
          .number()
          .int()
          .nonnegative()
          .max(USER_QUERY_LIMIT_MAX)
          .optional()
          .describe('Alias for skip'),
        search: z
          .string()
          .optional()
          .describe('Case-insensitive search across name, email, and unix_username'),
        query: z
          .string()
          .optional()
          .describe('Alias for search; case-insensitive name/email/unix_username lookup'),
        lean: z
          .boolean()
          .optional()
          .describe('Return compact rows only (default: true). Set false for detailed users.'),
        fields: z
          .array(z.enum(USER_LIST_FIELDS))
          .optional()
          .describe('Optional compact fields to return when lean is true'),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {
        $limit: args.limit ?? 50,
        $skip: args.skip ?? args.offset ?? 0,
      };
      if (args.search) query.search = args.search;
      if (args.query) query.search = args.query;

      const users = (await ctx.app.service('users').find({
        query,
        ...ctx.baseServiceParams,
      })) as { total: number; limit: number; skip: number; data: User[] };

      return textResult(args.lean === false ? users : compactUsersResult(users, args.fields));
    }
  );

  // Tool 2: agor_users_find
  server.registerTool(
    'agor_users_find',
    {
      description:
        'Find users by name, email, or unix_username. Useful before admin updates: returns compact matching rows with user_id. Pass email when available; matching is case-insensitive substring.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe('Case-insensitive search across name, email, and unix_username'),
        query: z.string().optional().describe('Alias for search'),
        email: z.string().optional().describe('Email to search for (case-insensitive substring)'),
        name: z.string().optional().describe('Name to search for (case-insensitive substring)'),
        unix_username: z
          .string()
          .optional()
          .describe('Unix username to search for (case-insensitive substring)'),
        limit: z
          .number()
          .int()
          .nonnegative()
          .max(USER_QUERY_LIMIT_MAX)
          .optional()
          .describe('Maximum number of matches (default: 10)'),
      }),
    },
    async (args) => {
      const genericTerms = [args.search, args.query].filter(
        (term): term is string => typeof term === 'string' && term.trim().length > 0
      );
      const fieldFilters = (
        [
          ['email', args.email],
          ['name', args.name],
          ['unix_username', args.unix_username],
        ] satisfies Array<[UserFindField, string | undefined]>
      ).filter((filter): filter is [UserFindField, string] => {
        const [, term] = filter;
        return typeof term === 'string' && term.trim().length > 0;
      });
      const firstFieldTerm = fieldFilters[0]?.[1];
      const searchTerm = genericTerms[0] ?? firstFieldTerm;

      if (!searchTerm) {
        throw new Error('Provide search, query, email, name, or unix_username');
      }

      const requestedLimit = args.limit ?? 10;
      const users = (await ctx.app.service('users').find({
        query: {
          search: searchTerm,
          $limit: fieldFilters.length > 0 ? USER_QUERY_LIMIT_MAX : requestedLimit,
          $skip: 0,
        },
        ...ctx.baseServiceParams,
      })) as { total: number; limit: number; skip: number; data: User[] };

      if (fieldFilters.length === 0) {
        return textResult(compactUsersResult(users));
      }

      const filteredData = users.data.filter((user) =>
        fieldFilters.every(([field, term]) => includesCaseInsensitive(user[field], term))
      );

      return textResult(
        compactUsersResult({
          total: filteredData.length,
          limit: requestedLimit,
          skip: 0,
          data: filteredData.slice(0, requestedLimit),
        })
      );
    }
  );

  // Tool 3: agor_users_get
  server.registerTool(
    'agor_users_get',
    {
      description: 'Get detailed information about a specific user',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        userId: z.string().describe('User ID (UUIDv7)'),
      }),
    },
    async (args) => {
      const user = await ctx.app.service('users').get(args.userId, ctx.baseServiceParams);
      return textResult(user);
    }
  );

  // Tool 4: agor_users_get_current
  server.registerTool(
    'agor_users_get_current',
    {
      description:
        'Get information about the current authenticated user (the user associated with this MCP session)',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const user = await ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams);
      return textResult(user);
    }
  );

  // Tool 5: agor_users_update_current
  server.registerTool(
    'agor_users_update_current',
    {
      description:
        'Update the current user profile (name, emoji, avatar, preferences). Can only update own profile.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        name: z.string().optional().describe('Display name'),
        emoji: z.string().optional().describe('User emoji (single emoji character)'),
        avatar: z.string().optional().describe('Avatar URL'),
        preferences: z
          .object({})
          .passthrough()
          .optional()
          .describe('User preferences (JSON object)'),
      }),
    },
    async (args) => {
      const updateData: Record<string, unknown> = {};
      if (args.name !== undefined) updateData.name = args.name;
      if (args.emoji !== undefined) updateData.emoji = args.emoji;
      if (args.avatar !== undefined) updateData.avatar = args.avatar;
      if (args.preferences !== undefined) updateData.preferences = args.preferences;
      const updatedUser = await ctx.app
        .service('users')
        .patch(ctx.userId, updateData, ctx.baseServiceParams);
      return textResult(updatedUser);
    }
  );

  // Tool 6: agor_users_update
  server.registerTool(
    'agor_users_update',
    {
      description:
        'Update any user account (admin operation). Only updates fields that are provided. Can update email, name, role, password, unix_username, must_change_password, emoji, avatar, and preferences.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        userId: z.string().describe('User ID to update (UUIDv7 or short ID)'),
        email: z.string().optional().describe('New email address (optional)'),
        name: z.string().optional().describe('New display name (optional)'),
        password: z.string().optional().describe('New password (optional, will be hashed)'),
        role: z
          .enum([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER, ROLES.VIEWER])
          .optional()
          .describe(
            'New user role (optional). superadmin=full system access + branch RBAC bypass, admin=manage resources, member=standard user, viewer=read-only'
          ),
        unix_username: z
          .string()
          .optional()
          .describe('New Unix username for shell access (optional)'),
        must_change_password: z
          .boolean()
          .optional()
          .describe('Force user to change password on next login (optional)'),
        emoji: z.string().optional().describe('User emoji (optional, single emoji character)'),
        avatar: z.string().optional().describe('Avatar URL (optional)'),
        preferences: z
          .object({})
          .passthrough()
          .optional()
          .describe('User preferences (optional, JSON object)'),
      }),
    },
    async (args) => {
      const updateData: Record<string, unknown> = {};
      if (args.email !== undefined) updateData.email = args.email;
      if (args.name !== undefined) updateData.name = args.name;
      if (args.password !== undefined) updateData.password = args.password;
      if (args.role !== undefined) updateData.role = args.role;
      if (args.unix_username !== undefined) updateData.unix_username = args.unix_username;
      if (args.must_change_password !== undefined)
        updateData.must_change_password = args.must_change_password;
      if (args.emoji !== undefined) updateData.emoji = args.emoji;
      if (args.avatar !== undefined) updateData.avatar = args.avatar;
      if (args.preferences !== undefined) updateData.preferences = args.preferences;

      if (Object.keys(updateData).length === 0) {
        throw new Error('at least one field must be provided to update');
      }

      const updatedUser = await ctx.app
        .service('users')
        .patch(args.userId, updateData, ctx.baseServiceParams);
      return textResult(updatedUser);
    }
  );

  // Tool 7: agor_user_create
  server.registerTool(
    'agor_user_create',
    {
      description:
        'Create a new user account. Requires email and password. Optionally set name, emoji, avatar, unix_username, must_change_password, and role.',
      inputSchema: z.object({
        email: z.string().describe('User email address (must be unique)'),
        password: z.string().describe('User password (will be hashed)'),
        name: z.string().optional().describe('Display name (optional)'),
        emoji: z
          .string()
          .optional()
          .describe('User emoji for visual identity (optional, single emoji character)'),
        avatar: z.string().optional().describe('Avatar URL (optional)'),
        unix_username: z
          .string()
          .optional()
          .describe(
            'Unix username for shell access (optional, defaults to email prefix if not specified)'
          ),
        must_change_password: z
          .boolean()
          .optional()
          .describe('Force user to change password on first login (optional, defaults to false)'),
        role: z
          .enum([ROLES.SUPERADMIN, ROLES.ADMIN, ROLES.MEMBER, ROLES.VIEWER])
          .optional()
          .describe(
            'User role (optional, defaults to "member"). Roles: superadmin=full system access + branch RBAC bypass, admin=manage resources, member=standard user, viewer=read-only'
          ),
      }),
    },
    async (args) => {
      const createData: Record<string, unknown> = {
        email: args.email,
        password: args.password,
      };
      if (args.name !== undefined) createData.name = args.name;
      if (args.emoji !== undefined) createData.emoji = args.emoji;
      if (args.avatar !== undefined) createData.avatar = args.avatar;
      if (args.unix_username !== undefined) createData.unix_username = args.unix_username;
      if (args.must_change_password !== undefined)
        createData.must_change_password = args.must_change_password;
      if (args.role !== undefined) createData.role = args.role;

      const newUser = await ctx.app.service('users').create(createData, ctx.baseServiceParams);
      return textResult(newUser);
    }
  );
}
