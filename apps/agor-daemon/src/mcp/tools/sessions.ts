import { AGENTIC_TOOL_CAPABILITIES } from '@agor/agentic-tools';
import {
  BranchRepository,
  type BranchWithZoneAndSessions,
  SessionRelationshipRepository,
  shortId,
} from '@agor/core/db';
import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  CODEX_MODEL_METADATA,
  COPILOT_MODEL_METADATA,
  CURSOR_MODEL_METADATA,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
} from '@agor/core/models';
import { resolveSessionDefaults } from '@agor/core/sessions';
import {
  AGENTIC_TOOL_NAMES,
  type AgenticToolName,
  type Board,
  getSessionType,
  type Session,
  type SessionType,
  type ZoneBoardObject,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { SessionsServiceImpl } from '../../declarations.js';
import type { SessionParams } from '../../services/sessions.js';
import { requireActiveAgenticTool } from '../../utils/agentic-tool-runtime.js';
import { ensureCanPromptTargetSession } from '../../utils/branch-authorization.js';
import { emitServiceEvent } from '../../utils/emit-service-event.js';
import {
  resolveBoardId,
  resolveBranchId,
  resolveMcpServerId,
  resolveSessionId,
} from '../resolve-ids.js';
import {
  mcpListLimit,
  mcpOffset,
  mcpOptionalId,
  mcpOptionalNonEmptyString,
  mcpOptionalPositiveInt,
  mcpOptionalString,
  mcpPageResult,
  mcpRequiredId,
  mcpRequiredString,
} from '../schema.js';
import type { McpContext } from '../server.js';
import { sessionContextRequiredResult, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope, runWithMcpTenantDatabaseWrite } from '../tenant-scope.js';
import { listAttachedMcpServers } from './mcp-servers.js';

/**
 * Shared Zod schema for specifying a model override at session-create / spawn /
 * subsession time. Mirrors Session['model_config']: `model` is required (the
 * whole point of this object is to pin a specific model), while `mode`,
 * `effort`, `advisorModel`, and `provider` are optional and fall back to
 * sensible defaults.
 * Wired through to `session.model_config` so the executor actually spawns on
 * the requested model (see query-builder.ts).
 *
 * Accepts two shapes for MCP-client ergonomics:
 *   - String shorthand: `"claude-opus-4-6"` — coerced via `coerceModelConfig`
 *     in each handler to `{ model: "claude-opus-4-6" }`. Most callers just
 *     want to pin a model — forcing them to construct the full object is
 *     hostile UX (and several MCP clients silently drop nested objects in
 *     tool args, see PR #1056 background).
 *   - Full object: `{ mode, model, effort, advisorModel, provider }` for
 *     callers that need to override `mode`/`effort`/`advisorModel`/`provider`.
 *
 * IMPORTANT — no `.transform()` here. Zod's JSON-Schema converter
 * (`zod/v4-mini`'s `toJSONSchema`, used in `mcp/server.ts` to populate the
 * cached registry consumed by `agor_get_tool_details`) throws on
 * transforms with "Transforms cannot be represented in JSON Schema". The
 * catch in `server.ts` then degrades the WHOLE containing tool schema to
 * `{ type: 'object' }`, hiding every input parameter from MCP clients. So
 * normalization happens in `coerceModelConfig` instead, called inline by
 * each handler.
 *
 * Call `agor_models_list` to discover valid model IDs per agenticTool.
 */
const modelConfigObjectSchema = z.object({
  mode: z.enum(['alias', 'exact']).optional().describe("Model selection mode (default: 'alias')"),
  // .min(1): reject empty-string model explicitly so callers don't silently
  // fall through to user defaults when they meant to pin a specific model.
  model: mcpRequiredString(
    'modelConfig.model',
    "Model identifier (e.g. 'claude-opus-4-6', 'claude-sonnet-4-6')"
  ),
  effort: z
    .enum(['low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .describe('Reasoning effort level (default: high)'),
  advisorModel: mcpOptionalString(
    'modelConfig.advisorModel',
    "Claude Code advisor model override (e.g. 'opus', 'sonnet', 'fable', or a full model ID)."
  ),
  provider: mcpOptionalString(
    'modelConfig.provider',
    "Provider ID (OpenCode only, e.g. 'anthropic')"
  ),
});

const modelConfigInputSchema = z
  .union([
    mcpRequiredString(
      'modelConfig',
      "Shorthand: just the model ID string (e.g. 'claude-opus-4-6'). Equivalent to { model: <id> }."
    ),
    modelConfigObjectSchema,
  ])
  .optional()
  .describe(
    "Model override for this session. Pass either a model ID string (e.g. 'claude-opus-4-6') or a full { mode, model, effort, advisorModel, provider } object. Overrides the user default model_config and is threaded through to the spawned agent process. Call agor_models_list to discover valid model IDs per agenticTool."
  );

/**
 * Normalize the two input shapes (string shorthand or full object) into the
 * partial-object shape downstream code expects (`ModelConfigInput` from
 * `@agor/core/models`). See `modelConfigInputSchema` for why this lives at
 * the handler boundary instead of as a Zod `.transform()`.
 */
type ModelConfigArg = string | z.infer<typeof modelConfigObjectSchema> | undefined;
function coerceModelConfig(
  input: ModelConfigArg
): z.infer<typeof modelConfigObjectSchema> | undefined {
  if (input === undefined) return undefined;
  if (typeof input === 'string') return { model: input };
  return input;
}

function filterSessionsByBranch<T extends { branch_id?: string }>(
  result: T[] | { data: T[]; total?: number; [key: string]: unknown },
  branchId: string
): T[] | { data: T[]; total?: number; [key: string]: unknown } {
  if (Array.isArray(result)) {
    return result.filter((session) => session.branch_id === branchId);
  }

  const data = result.data.filter((session) => session.branch_id === branchId);
  return { ...result, data, total: data.length };
}

function filterSessionsByBoard<T extends { branch_board_id?: string | null }>(
  result: T[] | { data: T[]; total?: number; [key: string]: unknown },
  boardId: string
): T[] | { data: T[]; total?: number; [key: string]: unknown } {
  if (Array.isArray(result)) {
    return result.filter((session) => session.branch_board_id === boardId);
  }

  const data = result.data.filter((session) => session.branch_board_id === boardId);
  return { ...result, data, total: data.length };
}

function redactSessionForMcp<T extends { mcp_token?: unknown }>(session: T): Omit<T, 'mcp_token'> {
  const { mcp_token: _mcpToken, ...safeSession } = session;
  return safeSession;
}

function compactSessionForMcp(session: Session) {
  return {
    session_id: session.session_id,
    title: session.title,
    description: session.description,
    status: session.status,
    agentic_tool: session.agentic_tool,
    branch_id: session.branch_id,
    branch_board_id: session.branch_board_id,
    url: session.url,
    created_by: session.created_by,
    created_at: session.created_at,
    last_updated: session.last_updated,
    genealogy: session.genealogy,
    task_count: session.tasks?.length ?? 0,
    schedule_id: session.schedule_id,
  };
}

function redactSessionFindResult<T extends { mcp_token?: unknown }>(
  result: T[] | { data: T[]; [key: string]: unknown }
): Array<Omit<T, 'mcp_token'>> | { data: Array<Omit<T, 'mcp_token'>>; [key: string]: unknown } {
  if (Array.isArray(result)) {
    return result.map(redactSessionForMcp);
  }

  return { ...result, data: result.data.map(redactSessionForMcp) };
}

export function registerSessionTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_sessions_list
  server.registerTool(
    'agor_sessions_list',
    {
      description:
        'List a lean page of sessions accessible to the current user. Runtime configuration, context files, task ID arrays, and SDK state are omitted by default; use agor_sessions_get for details or lean:false when required. Advance with offset=nextOffset while hasMore is true.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: mcpListLimit(),
        offset: mcpOffset(),
        lean: z.boolean().optional().describe('Return compact session records (default: true).'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('Filter by session status'),
        boardId: mcpOptionalId(
          'boardId',
          'Board',
          'Filter sessions by board ID (UUIDv7 or short ID)'
        ),
        branchId: mcpOptionalId('branchId', 'Branch', 'Filter sessions by branch ID'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived sessions in results (default: false). By default, archived sessions are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived sessions. When true, returns only archived sessions. Overrides includeArchived.'
          ),
        sessionType: z
          .enum(['gateway', 'scheduled', 'agent'])
          .optional()
          .describe(
            "Filter by session type. 'gateway' = sessions from messaging integrations (Slack, Discord, GitHub). 'scheduled' = sessions created by branch schedules. 'agent' = manually created sessions (excludes gateway and scheduled)."
          ),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      // When sessionType or boardId is set, skip service-level pagination
      // (it runs before our post-query filters) and apply the requested limit
      // ourselves after filtering.
      // Keep handler defaults explicit because unit/in-process callers may
      // invoke captured handlers without going through Zod defaulting.
      const requestedLimit = args.limit ?? 25;
      const requestedOffset = args.offset ?? 0;
      const boardId = args.boardId ? await resolveBoardId(ctx, args.boardId) : undefined;
      const needsPostQueryLimit = Boolean(args.sessionType || boardId);
      if (!needsPostQueryLimit) {
        query.$limit = requestedLimit;
        query.$skip = requestedOffset;
      }
      query.$sort = { created_at: -1, session_id: 1 };
      if (args.status) query.status = args.status;
      const branchId = args.branchId ? await resolveBranchId(ctx, args.branchId) : undefined;
      if (branchId) query.branch_id = branchId;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const result = await ctx.app.service('sessions').find({
        query: needsPostQueryLimit ? { ...query, $limit: 10000, $skip: 0 } : query,
        ...ctx.baseServiceParams,
      });

      // Defense-in-depth: the sessions service normally handles branch_id in
      // its query filter, but MCP callers rely on this tool contract. Keep the
      // response scoped even if an adapter/hook layer drops or rewrites the
      // query before it reaches the repository.
      const branchScopedResult = branchId ? filterSessionsByBranch(result, branchId) : result;
      const boardScopedResult = boardId
        ? filterSessionsByBoard(branchScopedResult, boardId)
        : branchScopedResult;

      // Apply post-query filters. sessionType is derived from fields that are
      // not in the query schema. boardId is exposed on Session as
      // branch_board_id via the branch join, not sessions.board_id (legacy
      // column is null for branch-backed sessions).
      if (needsPostQueryLimit) {
        const allData: Session[] = Array.isArray(boardScopedResult)
          ? boardScopedResult
          : boardScopedResult.data;
        const filtered = args.sessionType
          ? allData.filter((s) => getSessionType(s) === (args.sessionType as SessionType))
          : allData;
        const limited = filtered.slice(requestedOffset, requestedOffset + requestedLimit);

        if (Array.isArray(boardScopedResult)) {
          const data = limited.map((session) =>
            args.lean === false ? redactSessionForMcp(session) : compactSessionForMcp(session)
          );
          return textResult(mcpPageResult(data, requestedLimit, requestedOffset));
        }
        return textResult(
          mcpPageResult(
            {
              ...boardScopedResult,
              data: limited.map((session) =>
                args.lean === false ? redactSessionForMcp(session) : compactSessionForMcp(session)
              ),
              total: filtered.length,
            },
            requestedLimit,
            requestedOffset
          )
        );
      }

      const page = mcpPageResult(
        redactSessionFindResult(boardScopedResult) as {
          data: Array<Omit<Session, 'mcp_token'>>;
          total?: number;
          limit?: number;
          skip?: number;
        },
        requestedLimit,
        requestedOffset
      );
      return textResult(
        args.lean === false
          ? page
          : { ...page, data: page.data.map((session) => compactSessionForMcp(session as Session)) }
      );
    }
  );

  // Tool 2: agor_sessions_get
  server.registerTool(
    'agor_sessions_get',
    {
      description:
        'Get detailed information about a specific session, including genealogy, current state, and the MCP servers currently attached to it (with OAuth status — check `attached_mcp_servers[].oauth_authenticated` to spot servers needing auth). The response includes a `url` field with a clickable link to view the session in the UI.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID (UUIDv7 or short ID like 01a1b2c3)'
        ),
      }),
    },
    async (args) => {
      const sessionParams: SessionParams = {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
      };
      const session = await ctx.app
        .service('sessions')
        .get(args.sessionId, sessionParams as Parameters<SessionsServiceImpl['get']>[1]);
      const attached_mcp_servers = await listAttachedMcpServers(ctx, session.session_id);
      return textResult({ ...redactSessionForMcp(session), attached_mcp_servers });
    }
  );

  // Tool 3: agor_sessions_get_current
  server.registerTool(
    'agor_sessions_get_current',
    {
      description:
        'Get information about the current session (the one making this MCP call). Returns session details, denormalized branch/repo/board context, and the MCP servers attached to this session (each with `oauth_authenticated` so callers can spot servers needing auth). To browse the broader catalog of servers eligible to attach, use `agor_mcp_servers_list`. The returned session_id is the value a remote orchestrator passes as callbackSessionId (agor_sessions_create) to self-target cross-branch completion callbacks; agor_sessions_get_current_context is the leaner way to fetch it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      const currentSessionParams: SessionParams = {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
      };
      const session = await ctx.app
        .service('sessions')
        .get(currentSessionId, currentSessionParams as Parameters<SessionsServiceImpl['get']>[1]);

      // Denormalize branch, repo, and board context
      let branch: Record<string, unknown> | null = null;
      let repo: Record<string, unknown> | null = null;
      let board: Record<string, unknown> | null = null;

      if (session.branch_id) {
        try {
          const wt = await ctx.app
            .service('branches')
            .get(session.branch_id, ctx.baseServiceParams);
          branch = {
            branch_id: wt.branch_id,
            name: wt.name,
            ref: wt.ref,
            path: wt.path,
            board_id: wt.board_id,
            repo_id: wt.repo_id,
          };

          if (wt.repo_id) {
            try {
              const r = await ctx.app.service('repos').get(wt.repo_id, ctx.baseServiceParams);
              repo = {
                repo_id: r.repo_id,
                name: r.name,
                slug: r.slug,
              };
            } catch {
              // repo may have been deleted
            }
          }

          if (wt.board_id) {
            try {
              const b = await ctx.app.service('boards').get(wt.board_id, ctx.baseServiceParams);
              board = {
                board_id: b.board_id,
                name: b.name,
                slug: b.slug,
              };
            } catch {
              // board may have been deleted
            }
          }
        } catch {
          // branch may have been deleted
        }
      }

      const attached_mcp_servers = await listAttachedMcpServers(ctx, currentSessionId);

      return textResult({
        session: redactSessionForMcp(session),
        branch,
        repo,
        board,
        attached_mcp_servers,
      });
    }
  );

  // Tool 3b: agor_sessions_get_current_context
  // Returns a lean, deduplicated orientation payload. Each field appears exactly once.
  // Agents needing full entity details should call get_current, sessions_get, etc.
  server.registerTool(
    'agor_sessions_get_current_context',
    {
      description:
        'Get a lean orientation snapshot for the current session in ONE call. Returns deduplicated context: session identity, user, latest task Git boundaries, branch (zone, issue/PR, notes, environment), board (with zones), repo (slug, default branch), genealogy, and sibling sessions. Every field appears exactly once. Use get_current or entity-specific tools for full details. The returned session_id is what a remote orchestrator passes as callbackSessionId (agor_sessions_create) to self-target cross-branch completion callbacks.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        includeSiblings: z
          .boolean()
          .optional()
          .describe(
            'Include other active sessions in the same branch (default: true). Set false to reduce response size.'
          ),
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      const includeSiblings = args.includeSiblings !== false;

      // Fetch session and user in parallel (no dependencies)
      const [session, user] = await Promise.all([
        ctx.app.service('sessions').get(currentSessionId, ctx.baseServiceParams),
        ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams),
      ]);

      // Build the lean response — each piece of information appears exactly once
      const result: Record<string, unknown> = {
        // Session identity (the minimum to know "who am I")
        session_id: session.session_id,
        url: session.url,
        status: session.status,
        agentic_tool: session.agentic_tool,
        title: session.title,
        model: session.model_config?.model || null,
        effort: session.model_config?.effort || null,
        advisorModel: session.model_config?.advisorModel || null,

        // User (who is authenticated / who is prompting)
        user_name: user.name,
        user_email: user.email,
        user_role: user.role,
      };

      const latestTaskId = session.tasks?.at(-1);
      if (latestTaskId) {
        try {
          const latestTask = await ctx.app
            .service('tasks')
            .get(latestTaskId, ctx.baseServiceParams);
          const gitState = latestTask.git_state;
          result.latest_task_git_start = {
            ref: gitState.ref_at_start,
            sha: gitState.sha_at_start,
          };
          result.latest_task_git_end = gitState.sha_at_end
            ? {
                ref: gitState.ref_at_end ?? null,
                sha: gitState.sha_at_end,
              }
            : null;
        } catch {
          // The latest task may have been removed or be outside the caller's tenant scope.
        }
      }

      // Creator info only when different from authenticated user
      if (session.created_by && session.created_by !== ctx.userId) {
        try {
          const creator = await ctx.app
            .service('users')
            .get(session.created_by, ctx.baseServiceParams);
          result.created_by_name = creator.name;
          result.created_by_email = creator.email;
        } catch {
          // creator may have been deleted
        }
      }

      // Genealogy (flat — no nested object needed)
      const gen = session.genealogy;
      result.genealogy = gen?.parent_session_id
        ? 'spawned'
        : gen?.forked_from_session_id
          ? 'forked'
          : 'root';
      result.parent_session_id = gen?.parent_session_id || gen?.forked_from_session_id || null;
      result.children_count = gen?.children?.length || 0;

      if (session.branch_id) {
        try {
          // branches.get returns BranchWithZoneAndSessions (enriched with zone info)
          const wt = (await ctx.app
            .service('branches')
            .get(session.branch_id, ctx.baseServiceParams)) as BranchWithZoneAndSessions;

          // Branch context (no IDs that duplicate other sections)
          result.branch_id = wt.branch_id;
          result.branch_name = wt.name;
          result.branch_path = wt.path;
          result.base_ref = wt.base_ref || null;
          result.issue_url = wt.issue_url || null;
          result.pull_request_url = wt.pull_request_url || null;
          result.notes = wt.notes || null;
          result.zone_label = wt.zone_label || null;
          result.environment_status = wt.environment_instance?.status || null;
          result.app_url = wt.app_url || null;

          // Fetch repo and board in parallel
          const [repoResult, boardResult] = await Promise.allSettled([
            wt.repo_id
              ? ctx.app.service('repos').get(wt.repo_id, ctx.baseServiceParams)
              : Promise.reject(new Error('no repo')),
            wt.board_id
              ? ctx.app.service('boards').get(wt.board_id, ctx.baseServiceParams)
              : Promise.reject(new Error('no board')),
          ]);

          if (repoResult.status === 'fulfilled') {
            const r = repoResult.value;
            result.repo_slug = r.slug;
            result.repo_name = r.name;
            result.repo_path = r.local_path;
            result.default_branch = r.default_branch || null;
          }

          if (boardResult.status === 'fulfilled') {
            const b = boardResult.value;
            result.board_name = b.name;
            result.board_slug = b.slug;

            // Extract zones from board objects
            const boardObjects: Board['objects'] = b.objects;
            if (boardObjects) {
              const zones: { label?: string; status?: string; has_trigger: boolean }[] = [];
              for (const obj of Object.values(boardObjects)) {
                if (obj.type === 'zone') {
                  const zone = obj as ZoneBoardObject;
                  zones.push({
                    label: zone.label,
                    status: zone.status,
                    has_trigger: !!zone.trigger,
                  });
                }
              }
              if (zones.length > 0) {
                result.board_zones = zones;
              }
            }
          }

          // Sibling sessions in the same branch
          if (includeSiblings) {
            try {
              // Fetch 11 to guarantee 10 siblings after excluding current session
              const siblings = await ctx.app.service('sessions').find({
                query: {
                  branch_id: session.branch_id,
                  archived: false,
                  $limit: 11,
                  $sort: { last_updated: -1 },
                },
                ...ctx.baseServiceParams,
              });
              const siblingList = (Array.isArray(siblings) ? siblings : siblings.data)
                .filter((s: { session_id: string }) => s.session_id !== session.session_id)
                .slice(0, 10)
                .map(
                  (s: {
                    session_id: string;
                    title?: string;
                    status: string;
                    agentic_tool: string;
                  }) => ({
                    session_id: s.session_id,
                    title: s.title,
                    status: s.status,
                    agentic_tool: s.agentic_tool,
                  })
                );
              if (siblingList.length > 0) {
                result.sibling_sessions = siblingList;
              }
            } catch {
              // non-critical, skip
            }
          }
        } catch {
          // branch may have been deleted
        }
      }

      return textResult(result);
    }
  );

  // Tool 4: agor_sessions_spawn
  server.registerTool(
    'agor_sessions_spawn',
    {
      description:
        'Spawn a child session (subsession) for delegating work to another agent. Inherits the current branch and tracks parent-child genealogy. Use for subtasks like "run tests", "review this code", or "fix linting errors". Configuration is inherited from parent (same agent) or user defaults (different agent).',
      inputSchema: z.object({
        prompt: mcpRequiredString('prompt', 'The prompt/task for the subsession agent to execute'),
        title: mcpOptionalNonEmptyString(
          'title',
          'Optional title for the session (defaults to first 100 chars of prompt)'
        ),
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .optional()
          .describe('Which agent to use for the subsession (defaults to same as parent)'),
        enableCallback: z
          .boolean()
          .optional()
          .describe('Enable callback to parent on completion (default: true)'),
        includeLastMessage: z
          .boolean()
          .optional()
          .describe("Include child's final result in callback (default: true)"),
        includeOriginalPrompt: z
          .boolean()
          .optional()
          .describe('Include original spawn prompt in callback (default: false)'),
        extraInstructions: mcpOptionalString(
          'extraInstructions',
          'Extra instructions appended to spawn prompt'
        ),
        taskId: mcpOptionalId('taskId', 'Task', 'Optional task ID to link the spawned session to'),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server'))
          .optional()
          .describe(
            'MCP server IDs to attach. Overrides parent session inheritance. Omit to inherit from parent. Pass empty array for no MCPs.'
          ),
        modelConfig: modelConfigInputSchema,
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      const spawnData: Partial<import('@agor/core/types').SpawnConfig> = {
        prompt: args.prompt,
        title: args.title,
        agent: args.agenticTool as AgenticToolName | undefined,
        enableCallback: args.enableCallback,
        includeLastMessage: args.includeLastMessage,
        includeOriginalPrompt: args.includeOriginalPrompt,
        extraInstructions: args.extraInstructions,
        task_id: args.taskId,
        mcpServerIds: args.mcpServerIds,
        modelConfig: coerceModelConfig(args.modelConfig),
      };

      const childSession = await (
        ctx.app.service('sessions') as unknown as SessionsServiceImpl
      ).spawn(currentSessionId, spawnData, ctx.baseServiceParams);

      const task = await ctx.app.service('/sessions/:id/prompt').create(
        {
          prompt: args.prompt,
          permissionMode: childSession.permission_config?.mode || 'acceptEdits',
          stream: true,
        },
        {
          ...ctx.baseServiceParams,
          route: { id: childSession.session_id },
        }
      );

      return textResult({
        session: redactSessionForMcp(childSession),
        taskId: task.task_id,
        status: task.status,
        note: 'Subsession created and prompt execution started in background.',
      });
    }
  );

  // Tool 5: agor_sessions_prompt
  server.registerTool(
    'agor_sessions_prompt',
    {
      description:
        'Prompt an existing session to continue work. Supports four modes: continue (append to conversation), fork (branch at decision point), subsession (delegate to child agent), or btw (ephemeral fork — ask a side question without disrupting the target session, even if running). Configuration is inherited from parent session or user defaults.',
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to prompt (UUIDv7 or short ID)'
        ),
        prompt: mcpRequiredString('prompt', 'The prompt/task to execute'),
        mode: z
          .enum(['continue', 'fork', 'subsession', 'btw'])
          .describe(
            'How to route the work: continue (add to existing session), fork (create sibling session), subsession (create child session), btw (ephemeral fork — works even on running sessions, auto-callbacks result to caller, auto-archives when done)'
          ),
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .optional()
          .describe(
            'Agent for subsession (subsession mode only, defaults to parent agent). Fork mode always uses parent agent.'
          ),
        title: mcpOptionalNonEmptyString('title', 'Session title (for fork/subsession only)'),
        taskId: mcpOptionalId('taskId', 'Task', 'Fork/spawn point task ID (optional)'),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server'))
          .optional()
          .describe(
            'MCP server IDs for subsession mode. Overrides parent inheritance. Omit to inherit from parent. Pass empty array for no MCPs.'
          ),
        modelConfig: modelConfigInputSchema,
        callback: z
          .boolean()
          .optional()
          .describe(
            'Send a one-shot completion report for the exact prompted task back to the current calling Agor session.'
          ),
      }),
    },
    async (args) => {
      const mode = args.mode;
      const sessionId = await resolveSessionId(ctx, args.sessionId);
      if (args.callback && !ctx.sessionId) return sessionContextRequiredResult();
      if (args.callback) {
        await runWithMcpTenantDatabaseScope(ctx, (db) =>
          ensureCanPromptTargetSession(
            ctx.sessionId!,
            ctx.userId,
            ctx.app,
            new BranchRepository(db)
          )
        );
      }
      const callbackParams = args.callback
        ? {
            ...ctx.baseServiceParams,
            _taskCompletionCallback: {
              target_session_id: ctx.sessionId!,
              requested_from_session_id: ctx.sessionId!,
              requested_by_user_id: ctx.userId,
            },
          }
        : ctx.baseServiceParams;

      if (mode === 'continue') {
        // The prompt route returns the Task entity directly. Whether it ran
        // immediately or got queued is encoded in `task.status` — there's no
        // separate "queued vs ran" wire shape to branch on.
        const task = await ctx.app
          .service('/sessions/:id/prompt')
          .create(
            { prompt: args.prompt, stream: true },
            { ...callbackParams, route: { id: sessionId } }
          );

        if (task.status === 'queued') {
          return textResult({
            success: true,
            queued: true,
            taskId: task.task_id,
            queue_position: task.queue_position,
            note: 'Session is busy. Prompt has been queued and will execute automatically when the session becomes idle.',
          });
        }
        return textResult({
          success: true,
          taskId: task.task_id,
          status: task.status,
          note: 'Prompt added to existing session and execution started.',
        });
      } else if (mode === 'fork' || mode === 'btw') {
        // Check if the target session's tool supports forking
        const targetSession = await ctx.app
          .service('sessions')
          .get(sessionId, ctx.baseServiceParams);
        const targetTool = requireActiveAgenticTool(targetSession.agentic_tool);
        const caps = AGENTIC_TOOL_CAPABILITIES[targetTool];
        if (caps && !caps.supportsSessionFork) {
          return textResult({
            error: `${targetSession.agentic_tool} does not support session forking. Use mode "subsession" instead to delegate work to a fresh session.`,
          });
        }
        let btwCallbackSessionId: typeof ctx.sessionId;
        if (mode === 'btw') {
          if (!ctx.sessionId) return sessionContextRequiredResult();
          btwCallbackSessionId = ctx.sessionId;
        }

        // Shared fork+prompt flow for both "fork" and "btw" modes
        const forkData: { prompt: string; task_id?: string } = { prompt: args.prompt };
        if (args.taskId) forkData.task_id = args.taskId;

        const forkedSession = await (
          ctx.app.service('sessions') as unknown as SessionsServiceImpl
        ).fork(sessionId, forkData, ctx.baseServiceParams);

        // Build patch for the fork — title for both modes, btw-specific metadata for btw
        const forkPatch: Record<string, unknown> = {};
        if (args.title) forkPatch.title = args.title;

        if (mode === 'btw') {
          forkPatch.fork_origin = 'btw';
          forkPatch.callback_config = {
            enabled: true,
            callback_session_id: btwCallbackSessionId,
            callback_created_by: ctx.userId,
            callback_mode: 'once',
          };
        }

        if (Object.keys(forkPatch).length > 0) {
          await ctx.app
            .service('sessions')
            .patch(forkedSession.session_id, forkPatch, ctx.baseServiceParams);
        }

        const updatedSession = await ctx.app
          .service('sessions')
          .get(forkedSession.session_id, ctx.baseServiceParams);

        const task = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.prompt,
            permissionMode: updatedSession.permission_config?.mode,
            stream: true,
          },
          { ...callbackParams, route: { id: forkedSession.session_id } }
        );

        const note =
          mode === 'btw'
            ? 'Ephemeral "btw" fork created. Result will be sent back via callback when done, then the fork will auto-archive.'
            : 'Forked session created and prompt execution started.';

        return textResult({
          session: redactSessionForMcp(updatedSession),
          taskId: task.task_id,
          status: task.status,
          note,
        });
      } else if (mode === 'subsession') {
        const spawnData: Partial<import('@agor/core/types').SpawnConfig> = {
          prompt: args.prompt,
          mcpServerIds: args.mcpServerIds,
          modelConfig: coerceModelConfig(args.modelConfig),
        };
        if (args.title) spawnData.title = args.title;
        if (args.agenticTool) spawnData.agent = args.agenticTool as AgenticToolName;
        if (args.taskId) spawnData.task_id = args.taskId;

        const childSession = await (
          ctx.app.service('sessions') as unknown as SessionsServiceImpl
        ).spawn(sessionId, spawnData, ctx.baseServiceParams);

        const task = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.prompt,
            permissionMode: childSession.permission_config?.mode,
            stream: true,
          },
          { ...callbackParams, route: { id: childSession.session_id } }
        );

        return textResult({
          session: redactSessionForMcp(childSession),
          taskId: task.task_id,
          status: task.status,
          note: 'Subsession created and prompt execution started.',
        });
      }

      return textResult({ error: `Unknown mode: ${mode}` });
    }
  );

  // Tool 5b: agor_session_relationships_list
  server.registerTool(
    'agor_session_relationships_list',
    {
      description:
        'List durable non-genealogy relationships for a session, including cross-branch remote-created child/parent links. Defaults to the current session.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: mcpOptionalId(
          'sessionId',
          'Session',
          'Session ID to inspect (defaults to current session)'
        ),
      }),
    },
    async (args) => {
      const sessionId = args.sessionId
        ? await resolveSessionId(ctx, args.sessionId)
        : ctx.sessionId;
      if (!sessionId) return sessionContextRequiredResult();

      // Validate normal session access/RBAC before returning links.
      await ctx.app.service('sessions').get(sessionId, ctx.baseServiceParams);

      const relationships = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new SessionRelationshipRepository(db).findForSession(sessionId)
      );
      return textResult({ relationships });
    }
  );

  // Tool 5c: agor_session_relationships_set_callback
  server.registerTool(
    'agor_session_relationships_set_callback',
    {
      description:
        'Enable or disable callback/report-back delivery for a durable session relationship without deleting the relationship itself. Works for cross-branch relationships too (e.g. a remote-created child reporting back to an orchestrator living on another branch).',
      inputSchema: z.object({
        relationshipId: mcpRequiredString(
          'relationshipId',
          'Session relationship ID returned by agor_session_relationships_list'
        ),
        callbackEnabled: z.boolean().describe('Whether the remote child should report back.'),
      }),
    },
    async (args) => {
      const relationshipId =
        args.relationshipId as import('@agor/core/types').SessionRelationshipID;
      const existingRelationship = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new SessionRelationshipRepository(db).get(relationshipId)
      );

      // Authorize visibility/access before mutating the durable relationship.
      // Reading both sides through the sessions service keeps this tool aligned
      // with normal session RBAC instead of treating relationship IDs as ambient
      // authority.
      await ctx.app
        .service('sessions')
        .get(existingRelationship.source_session_id, ctx.baseServiceParams);
      const targetSession = await ctx.app
        .service('sessions')
        .get(existingRelationship.target_session_id, ctx.baseServiceParams);

      const relationship = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        new SessionRelationshipRepository(db).setCallbackEnabled(
          relationshipId,
          args.callbackEnabled
        )
      );
      const callbackSessionId = relationship.callback_session_id ?? relationship.source_session_id;
      await ctx.app.service('sessions').patch(
        relationship.target_session_id,
        {
          callback_config: {
            ...(targetSession.callback_config ?? {}),
            enabled: args.callbackEnabled,
            callback_session_id: callbackSessionId,
          },
        },
        {
          ...ctx.baseServiceParams,
          _skipRelationshipCallbackSync: true,
        } as typeof ctx.baseServiceParams
      );

      return textResult({ relationship });
    }
  );

  // Tool 6: agor_sessions_create
  server.registerTool(
    'agor_sessions_create',
    {
      description:
        'Create a new session in an existing branch. When called from an MCP session context in the same target branch (the default for branch-local orchestrator agents), the new session is automatically linked to the calling session as its parent — pass `parentSessionId: null` to create an unlinked root session instead. Cross-branch sessions are not genealogy-linked automatically; use callbacks for remote completion routing. Use for starting work on a new task in the same codebase (e.g., new feature branch, separate investigation). MCP servers are inherited from the branch (if configured) or user defaults, or can be overridden via `mcpServerIds`. Model selection falls back to user defaults and can be overridden via `modelConfig` (accepts either a model ID string like "claude-opus-4-6" or a full {mode, model, effort, advisorModel, provider} object — call `agor_models_list` to discover valid model IDs per agenticTool). Supports optional callbacks to notify the creating session when the new session completes.',
      inputSchema: z.object({
        branchId: mcpRequiredId(
          'branchId',
          'Branch',
          'Branch ID where the session will run (required)'
        ),
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .describe('Which agent to use for this session (required)'),
        title: mcpOptionalNonEmptyString('title', 'Session title (optional)'),
        description: mcpOptionalString('description', 'Session description (optional)'),
        contextFiles: z
          .array(mcpRequiredString('contextFiles[]', 'Context file path'))
          .optional()
          .describe('Context file paths to load (optional)'),
        initialPrompt: mcpRequiredString(
          'initialPrompt',
          'Initial prompt to execute immediately after creating the session (optional)'
        ).optional(),
        enableCallback: z
          .boolean()
          .optional()
          .describe(
            'Enable callback to the creating session when the new session completes (default: false). When true, the creating session will receive a completion notification.'
          ),
        callbackSessionId: mcpOptionalId(
          'callbackSessionId',
          'Session',
          'Session ID to notify on completion (defaults to the current/creating session when enableCallback is true). ' +
            'Not restricted to the target branch: this may be a session in a DIFFERENT branch — e.g. a remote orchestrator registering its own session (fetch that ID via agor_sessions_get_current_context) to be notified when cross-branch work finishes.'
        ),
        includeLastMessage: z
          .boolean()
          .optional()
          .describe(
            "Include the new session's final result in the callback message (default: true)"
          ),
        includeOriginalPrompt: z
          .boolean()
          .optional()
          .describe('Include the original prompt in the callback message (default: false)'),
        callbackMode: z
          .enum(['once', 'persistent'])
          .optional()
          .describe(
            'Callback firing mode: "persistent" (default) fires on every completion until unlinked, "once" fires on the first completion then auto-disables'
          ),
        parentSessionId: z
          .string()
          .min(1, 'parentSessionId cannot be empty when provided.')
          .nullish()
          .describe(
            'Parent session ID to link this session to in the branch-local genealogy tree. Must be in the target branch. When omitted and called from a session MCP context in the same branch, automatically defaults to the calling session. Pass null to explicitly create a root session with no parent; use callbackSessionId for cross-branch routing.'
          ),
        mcpServerIds: z
          .array(mcpRequiredId('mcpServerIds[]', 'MCP server'))
          .optional()
          .describe(
            'MCP server IDs to attach. Overrides branch and user default inheritance. Omit to use branch config > user defaults.'
          ),
        modelConfig: modelConfigInputSchema,
      }),
    },
    async (args) => {
      const agenticTool = args.agenticTool as AgenticToolName;

      // Fetch user data to get unix_username
      const user = await ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams);

      // Get branch to extract repo context
      const branch = await ctx.app.service('branches').get(args.branchId, ctx.baseServiceParams);

      // Session creation materializes permission/model defaults centrally so
      // selected presets retain their provenance. MCP attachment remains here
      // because explicit attach failures are part of this tool's response.
      const explicitMcpServerIds =
        args.mcpServerIds !== undefined
          ? await Promise.all(args.mcpServerIds.map((id) => resolveMcpServerId(ctx, id)))
          : undefined;
      const modelConfig = coerceModelConfig(args.modelConfig);
      const mcpServerIds = resolveSessionDefaults({
        agenticTool,
        user,
        branch,
        overrides: { mcpServerIds: explicitMcpServerIds },
      }).mcp_server_ids;
      // Track whether the caller explicitly requested these servers. When they
      // did, we surface attach failures in the response instead of silently
      // dropping them (the "mcpServerId doesn't stick" bug). For inherited
      // servers (branch/user defaults) we preserve the existing "gracefully
      // skip deleted/invalid" behavior so startup doesn't get chatty.
      const mcpServerIdsFromArgs = args.mcpServerIds !== undefined;

      // Build callback configuration for remote session callbacks
      const callbackConfig: Record<string, unknown> = {};

      // Determine the effective callback target session ID
      const effectiveCallbackSessionId = args.callbackSessionId || ctx.sessionId;
      const wantsCallback = args.enableCallback || args.callbackSessionId;
      if (wantsCallback && !effectiveCallbackSessionId) return sessionContextRequiredResult();

      // Validate user has prompt permission on the callback target session's branch
      if (wantsCallback && effectiveCallbackSessionId) {
        await runWithMcpTenantDatabaseScope(ctx, (db) =>
          ensureCanPromptTargetSession(
            effectiveCallbackSessionId,
            ctx.userId,
            ctx.app,
            new BranchRepository(db)
          )
        );
      }

      if (args.enableCallback !== undefined) {
        callbackConfig.enabled = args.enableCallback;
      }
      if (wantsCallback) {
        callbackConfig.enabled = true;
        callbackConfig.callback_session_id = effectiveCallbackSessionId;
        callbackConfig.callback_created_by = ctx.userId;
      }
      if (args.includeLastMessage !== undefined) {
        callbackConfig.include_last_message = args.includeLastMessage;
      }
      if (args.includeOriginalPrompt !== undefined) {
        callbackConfig.include_original_prompt = args.includeOriginalPrompt;
      }
      if (wantsCallback) {
        callbackConfig.callback_mode = args.callbackMode ?? 'persistent';
      }

      // Determine the parent session to link to in the genealogy, and — for a
      // cross-branch create — the source of the durable `remote_create`
      // provenance edge.
      //
      // `parent_session_id` is the canonical branch-local session tree used by
      // fork/spawn UI and recursive delete semantics. `remote_create` is a
      // separate, cross-branch *provenance* edge (rendered as a surrogate under
      // the creator in the SessionTree). Provenance answers "which session
      // created this child" — it is ALWAYS the calling session, never the
      // callback target (that only answers "where should completion be
      // delivered", i.e. routing). Keep the two concerns distinct:
      // - explicit string: resolve (supports short IDs), require same branch,
      //   use as the genealogy parent.
      // - explicit null: opt out of *genealogy* only. This is orthogonal to
      //   provenance: a cross-branch calling session is still recorded as the
      //   remote creator below, so an "unlinked root session" that a remote
      //   orchestrator spun up still surfaces under that orchestrator.
      // - undefined (omitted): auto-link to the calling session as the
      //   genealogy parent only when it shares the new session's branch.
      // In every case, a calling session in a *different* branch is the remote
      // creator and gets a `remote_create` edge. With no calling session there
      // is no creator to attribute, so no provenance edge is written (the child
      // still carries callback_config, so completion is still delivered).
      let resolvedParentSessionId: string | undefined;
      let parentSessionForPatch: Session | undefined;
      let skippedAutoParentDueToBranchMismatch = false;
      let remoteRelationshipSourceSessionId: string | undefined;
      let remoteRelationshipSourceBranchId: string | undefined;

      // Decision 1 — genealogy: resolve an EXPLICIT parent (same-branch only).
      // Implicit same-branch genealogy is handled in decision 2.
      if (args.parentSessionId !== undefined && args.parentSessionId !== null) {
        resolvedParentSessionId = await resolveSessionId(ctx, args.parentSessionId);
        parentSessionForPatch = (await ctx.app
          .service('sessions')
          .get(resolvedParentSessionId, ctx.baseServiceParams)) as Session;

        if (parentSessionForPatch.branch_id !== branch.branch_id) {
          throw new Error(
            `parentSessionId must reference a session in the target branch (${shortId(branch.branch_id)}). ` +
              'For cross-branch completion routing, use enableCallback/callbackSessionId instead of genealogy.'
          );
        }
      }

      // Decision 2 — inspect the calling session, independently of genealogy.
      // A cross-branch caller is the remote creator and ALWAYS gets a
      // `remote_create` edge (it can coexist with an explicit same-branch
      // genealogy parent). A same-branch caller becomes the implicit genealogy
      // parent only when `parentSessionId` was omitted (an explicit parent
      // wins; `null` opts out).
      if (ctx.sessionId) {
        const callingSession = (await ctx.app
          .service('sessions')
          .get(ctx.sessionId, ctx.baseServiceParams)) as Session;

        if (callingSession.branch_id === branch.branch_id) {
          if (args.parentSessionId === undefined && !resolvedParentSessionId) {
            resolvedParentSessionId = callingSession.session_id;
            parentSessionForPatch = callingSession;
          }
          // parentSessionId: null in the same branch → intentionally unlinked;
          // no genealogy parent and no cross-branch provenance.
        } else {
          skippedAutoParentDueToBranchMismatch = true;
          remoteRelationshipSourceSessionId = callingSession.session_id;
          remoteRelationshipSourceBranchId = callingSession.branch_id;
        }
      }

      if (remoteRelationshipSourceSessionId && effectiveCallbackSessionId) {
        // For remote-created sessions, keep the callback endpoint durable even
        // when delivery is muted. `enabled` / relationship.callback_enabled are
        // the switches; callback_session_id is needed for generic session
        // settings/update paths to re-enable callbacks later.
        callbackConfig.enabled ??= Boolean(wantsCallback);
        callbackConfig.callback_session_id ??= effectiveCallbackSessionId;
        callbackConfig.callback_created_by ??= ctx.userId;
      }

      const sessionData: Record<string, unknown> = {
        branch_id: branch.branch_id,
        agentic_tool: agenticTool,
        status: 'idle',
        title: args.title,
        description: args.description,
        created_by: ctx.userId,
        unix_username: user.unix_username,
        ...(modelConfig && { model_config: modelConfig }),
        ...(Object.keys(callbackConfig).length > 0 && { callback_config: callbackConfig }),
        contextFiles: args.contextFiles || [],
        genealogy: {
          ...(resolvedParentSessionId && { parent_session_id: resolvedParentSessionId }),
          children: [],
        },
        tasks: [],
      };

      const session = await ctx.app.service('sessions').create(sessionData, ctx.baseServiceParams);

      const remoteRelationship = remoteRelationshipSourceSessionId
        ? await runWithMcpTenantDatabaseScope(ctx, (db) =>
            new SessionRelationshipRepository(db).create({
              source_session_id: remoteRelationshipSourceSessionId as Session['session_id'],
              target_session_id: session.session_id,
              relationship_type: 'remote_create',
              created_by: ctx.userId,
              callback_enabled: Boolean(wantsCallback),
              // Keep the durable relationship target even when callbacks are
              // muted. callback_enabled/callback_config.enabled are the delivery
              // switches; callback_session_id is the stable endpoint to re-enable.
              callback_session_id: effectiveCallbackSessionId
                ? (effectiveCallbackSessionId as Session['session_id'])
                : null,
              data: {
                source_branch_id: remoteRelationshipSourceBranchId,
                target_branch_id: branch.branch_id,
              },
            })
          )
        : null;

      if (remoteRelationship && remoteRelationshipSourceSessionId) {
        const sourceSession = await ctx.app
          .service('sessions')
          .get(remoteRelationshipSourceSessionId, ctx.baseServiceParams);
        emitServiceEvent(ctx.app, {
          path: 'sessions',
          event: 'patched',
          data: sourceSession,
          params: ctx.baseServiceParams,
          id: sourceSession.session_id,
        });
      }

      // Update the parent session's children list to include the new session.
      if (resolvedParentSessionId && parentSessionForPatch) {
        await ctx.app.service('sessions').patch(
          resolvedParentSessionId,
          {
            genealogy: {
              ...parentSessionForPatch.genealogy,
              children: [...(parentSessionForPatch.genealogy?.children ?? []), session.session_id],
            },
          },
          ctx.baseServiceParams
        );
      }

      // Attach MCP servers (inherited from branch or user defaults, or
      // explicitly requested via args.mcpServerIds). Explicit failures are
      // collected and returned to the caller so they don't silently vanish.
      const mcpAttachFailures: Array<{ mcp_server_id: string; reason: string }> = [];
      if (mcpServerIds && mcpServerIds.length > 0) {
        for (const mcpServerId of mcpServerIds) {
          try {
            // Attach via the session-scoped REST surface — `session-mcp-servers`
            // (flat) is read-only here; the create handler lives on
            // `/sessions/:id/mcp-servers` with `{ mcpServerId }` (camelCase).
            // See register-routes.ts: `/sessions/:id/mcp-servers` create handler.
            await ctx.app
              .service('/sessions/:id/mcp-servers')
              .create(
                { mcpServerId },
                { ...ctx.baseServiceParams, route: { id: session.session_id } }
              );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (mcpServerIdsFromArgs) {
              // Caller explicitly asked for this server — surface the failure.
              mcpAttachFailures.push({ mcp_server_id: mcpServerId, reason });
            } else {
              // Inherited from branch/user defaults — gracefully skip.
              console.warn(
                `Skipped MCP server ${mcpServerId} for session ${session.session_id}: ${reason}`
              );
            }
          }
        }
      }

      // Execute initial prompt if provided
      let initialTask = null;
      if (args.initialPrompt) {
        initialTask = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.initialPrompt,
            permissionMode: session.permission_config?.mode,
            stream: true,
          },
          { ...ctx.baseServiceParams, route: { id: session.session_id } }
        );
      }

      const callbackNote = callbackConfig.callback_session_id
        ? ` Callback will be sent to session ${shortId(callbackConfig.callback_session_id as string)} on completion.`
        : '';

      const parentNote = resolvedParentSessionId
        ? ` Linked to parent session ${shortId(resolvedParentSessionId)}.`
        : skippedAutoParentDueToBranchMismatch
          ? ' Not genealogy-linked because the target branch differs from the calling session branch.'
          : '';

      const mcpFailureNote =
        mcpAttachFailures.length > 0
          ? ` Warning: ${mcpAttachFailures.length} requested MCP server(s) failed to attach — see mcpAttachFailures.`
          : '';

      return textResult({
        session: redactSessionForMcp(session),
        taskId: initialTask?.task_id,
        note: args.initialPrompt
          ? `Session created and initial prompt execution started.${parentNote}${callbackNote}${mcpFailureNote}`
          : `Session created successfully.${parentNote}${callbackNote}${mcpFailureNote}`,
        ...(remoteRelationship && { remoteRelationship }),
        ...(mcpAttachFailures.length > 0 && { mcpAttachFailures }),
      });
    }
  );

  // Tool 7: agor_sessions_update
  server.registerTool(
    'agor_sessions_update',
    {
      description:
        'Update session metadata (title, description, status, archived, callback config). Useful for agents to self-document their work or manage callback settings.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to update (UUIDv7 or short ID)'
        ),
        title: mcpOptionalString('title', 'New session title (optional)'),
        description: mcpOptionalString('description', 'New session description (optional)'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('New session status (optional)'),
        archived: z
          .boolean()
          .optional()
          .describe('Set archive state. true to archive, false to unarchive (optional)'),
        enableCallback: z
          .boolean()
          .optional()
          .describe('Enable or disable callbacks on this session (optional)'),
        callbackMode: z
          .enum(['once', 'persistent'])
          .optional()
          .describe(
            'Callback mode: "once" fires once then auto-disables, "persistent" fires every time (optional)'
          ),
      }),
    },
    async (args) => {
      const updates: Record<string, unknown> = {};
      if (args.title !== undefined) updates.title = args.title;
      if (args.description !== undefined) updates.description = args.description;
      if (args.status !== undefined) updates.status = args.status;
      if (args.archived !== undefined) {
        updates.archived = args.archived;
        updates.archived_reason = args.archived ? 'manual' : undefined;
      }

      // Handle callback config updates
      if (args.enableCallback !== undefined || args.callbackMode !== undefined) {
        const sessionId = await resolveSessionId(ctx, args.sessionId);
        const existingSession = await ctx.app
          .service('sessions')
          .get(sessionId, ctx.baseServiceParams);
        const existingCallback = existingSession.callback_config || {};
        updates.callback_config = {
          ...existingCallback,
          ...(args.enableCallback !== undefined ? { enabled: args.enableCallback } : {}),
          ...(args.callbackMode !== undefined ? { callback_mode: args.callbackMode } : {}),
        };
      }

      if (Object.keys(updates).length === 0) {
        throw new Error(
          'At least one field (title, description, status, archived, enableCallback, callbackMode) must be provided'
        );
      }

      const session = await ctx.app
        .service('sessions')
        .patch(args.sessionId, updates, ctx.baseServiceParams);
      return textResult({
        session: redactSessionForMcp(session),
        note: 'Session updated successfully.',
      });
    }
  );

  // Tool 8: agor_sessions_archive
  server.registerTool(
    'agor_sessions_archive',
    {
      description:
        'Archive a session (soft delete). Archived sessions are hidden from listings by default but can be restored. By default, all child sessions (forks and subsessions) are also archived. Set includeChildren to false to archive only the target session.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to archive (UUIDv7 or short ID)'
        ),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Also archive all child sessions (forks and subsessions). Default: true.'),
      }),
    },
    async (args) => {
      const includeChildren = args.includeChildren !== false;
      const sessionsService = ctx.app.service('sessions') as unknown as SessionsServiceImpl;
      // archive() -> setArchiveStateForTree touches this.db (this.get,
      // sessionRepo writes) directly and is not a Feathers transport method, so
      // enter the tenant DB scope here (the HTTP archive route enters it via its
      // around hook). The whole tree update is DB-only — no network held.
      const result = await runWithMcpTenantDatabaseWrite(ctx, () =>
        sessionsService.archive(args.sessionId, { includeChildren }, ctx.baseServiceParams)
      );

      return textResult({
        success: true,
        archivedCount: result.count,
        message: `Archived ${result.count} session(s).`,
      });
    }
  );

  // Tool 9: agor_sessions_unarchive
  server.registerTool(
    'agor_sessions_unarchive',
    {
      description:
        'Restore a previously archived session. By default, all child sessions are also unarchived. Set includeChildren to false to unarchive only the target session.',
      inputSchema: z.object({
        sessionId: mcpRequiredId(
          'sessionId',
          'Session',
          'Session ID to unarchive (UUIDv7 or short ID)'
        ),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Also unarchive all child sessions (forks and subsessions). Default: true.'),
      }),
    },
    async (args) => {
      const includeChildren = args.includeChildren !== false;
      const sessionsService = ctx.app.service('sessions') as unknown as SessionsServiceImpl;
      // Same as archive: enter the tenant DB scope around the (DB-only) tree walk.
      const result = await runWithMcpTenantDatabaseWrite(ctx, () =>
        sessionsService.unarchive(args.sessionId, { includeChildren }, ctx.baseServiceParams)
      );

      return textResult({
        success: true,
        unarchivedCount: result.count,
        message: `Unarchived ${result.count} session(s).`,
      });
    }
  );

  // Tool 10: agor_sessions_bulk_archive
  server.registerTool(
    'agor_sessions_bulk_archive',
    {
      description:
        'Archive multiple sessions matching filter criteria. Supports filtering by session type (gateway/scheduled/agent), age, status, board, and branch. Returns a dry-run preview by default — set dryRun to false to actually archive. Respects RBAC: sessions the current user cannot modify are skipped and reported as errors.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        sessionType: z
          .enum(['gateway', 'scheduled', 'agent'])
          .optional()
          .describe(
            "Filter by session type. 'gateway' = messaging integrations, 'scheduled' = cron-triggered, 'agent' = manually created."
          ),
        olderThanDays: mcpOptionalPositiveInt(
          'olderThanDays',
          'Only archive sessions last updated more than this many days ago'
        ).refine((value) => value === undefined || value <= 365, {
          message: 'olderThanDays must be less than or equal to 365.',
        }),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('Only archive sessions with this status'),
        boardId: mcpOptionalId('boardId', 'Board', 'Only archive sessions on this board'),
        branchId: mcpOptionalId('branchId', 'Branch', 'Only archive sessions in this branch'),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'Preview which sessions would be archived without actually archiving them (default: true)'
          ),
      }),
    },
    async (args) => {
      const dryRun = args.dryRun !== false;

      // Build service query for non-archived sessions
      const query: Record<string, unknown> = { archived: false };
      if (args.status) query.status = args.status;
      const boardId = args.boardId ? await resolveBoardId(ctx, args.boardId) : undefined;
      if (args.branchId) query.branch_id = await resolveBranchId(ctx, args.branchId);

      // Fetch all matching sessions (paginate through all results)
      const allSessions: Session[] = [];
      let skip = 0;
      const pageSize = 200;

      while (true) {
        const result = await ctx.app
          .service('sessions')
          .find({ query: { ...query, $limit: pageSize, $skip: skip }, ...ctx.baseServiceParams });
        const page: Session[] = Array.isArray(result) ? result : result.data;
        allSessions.push(...page);
        if (page.length < pageSize) break;
        skip += pageSize;
      }

      // Apply post-query filters (sessionType, age)
      const cutoffDate = args.olderThanDays
        ? new Date(Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000)
        : null;

      const toArchive = allSessions.filter((s) => {
        if (boardId && s.branch_board_id !== boardId) return false;
        if (args.sessionType && getSessionType(s) !== args.sessionType) return false;
        if (cutoffDate) {
          const lastUpdated = new Date(s.last_updated || s.created_at);
          if (lastUpdated >= cutoffDate) return false;
        }
        return true;
      });

      if (dryRun) {
        return textResult({
          dryRun: true,
          wouldArchive: toArchive.length,
          totalMatched: allSessions.length,
          ...(cutoffDate && { cutoffDate: cutoffDate.toISOString() }),
          sessions: toArchive.map((s) => ({
            session_id: s.session_id,
            title: s.title,
            status: s.status,
            session_type: getSessionType(s),
            last_updated: s.last_updated,
            created_at: s.created_at,
            branch_id: s.branch_id,
          })),
          message: `Would archive ${toArchive.length} session(s). Set dryRun=false to proceed.`,
        });
      }

      // Archive each session (through service layer for RBAC)
      let archivedCount = 0;
      const errors: { session_id: string; error: string }[] = [];

      for (const session of toArchive) {
        try {
          await ctx.app
            .service('sessions')
            .patch(
              session.session_id,
              { archived: true, archived_reason: 'manual' },
              ctx.baseServiceParams
            );
          archivedCount++;
        } catch (error) {
          errors.push({
            session_id: session.session_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return textResult({
        success: true,
        archivedCount,
        failedCount: errors.length,
        ...(cutoffDate && { cutoffDate: cutoffDate.toISOString() }),
        errors: errors.length > 0 ? errors : undefined,
        message: `Archived ${archivedCount} session(s).${errors.length > 0 ? ` ${errors.length} failed (insufficient permissions or other errors).` : ''}`,
      });
    }
  );

  // Tool 12: agor_sessions_stop
  server.registerTool(
    'agor_sessions_stop',
    {
      description:
        'Request that a running session stop. The session becomes idle only after Agor verifies executor quiescence or process absence; otherwise it remains guarded in stopping. Use this for emergency stops, timeout-based cancellation, or human-in-the-loop gates. Only works on sessions in active states (running, stopping, awaiting_permission, awaiting_input).',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        sessionId: mcpRequiredId('sessionId', 'Session', 'Session ID to stop (UUIDv7 or short ID)'),
        reason: mcpOptionalString(
          'reason',
          'Audit log reason for the stop (e.g. "timeout", "user requested", "safety gate")'
        ),
      }),
    },
    async (args) => {
      const sessionId = await resolveSessionId(ctx, args.sessionId);

      const result = await ctx.app
        .service('/sessions/:id/stop')
        .create(
          { ...(args.reason ? { reason: args.reason } : {}) },
          { ...ctx.baseServiceParams, route: { id: sessionId } }
        );

      const stopResult = result as { success: boolean; status?: string; reason?: string };

      if (!stopResult.success) {
        return textResult({
          success: false,
          sessionId,
          error: stopResult.reason || 'Failed to stop session',
        });
      }

      return textResult({
        success: true,
        sessionId,
        status: stopResult.status,
        ...(args.reason ? { reason: args.reason } : {}),
        note: stopResult.reason || 'Session stopped successfully.',
      });
    }
  );

  // Tool 13: agor_models_list
  //
  // Discovery tool so MCP-driven agents can find valid `model` strings without
  // having to scrape tool descriptions. Sourced from the same in-process model
  // registries the UI uses (packages/core/src/models/*). This reads the
  // registry loaded by the running daemon; it is not provider discovery.
  //
  // Caveats:
  //   - Gemini's authoritative list is fetched live from the Google API per
  //     user (fetchGeminiModels). The hardcoded fallback IS exposed here as a
  //     best-effort starter list.
  //   - Copilot and Cursor have dynamic discovery exposed via /copilot-models
  //     and /cursor-models in the daemon. Static fallbacks are exposed here.
  //   - OpenCode is a provider+model matrix and doesn't have a single static
  //     list. Its entry explains that discovery happens after provider choice.
  server.registerTool(
    'agor_models_list',
    {
      description:
        'List selectable model aliases grouped by agenticTool. Use this to discover what to pass for `modelConfig` (or its string shorthand) in agor_sessions_create / spawn / prompt. Lists the registry loaded by the running daemon; provider-specific exact IDs may be account-dependent.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        agenticTool: z
          .enum(AGENTIC_TOOL_NAMES)
          .optional()
          .describe('Filter to a single agentic tool. Omit to return all tools.'),
      }),
    },
    async (args) => {
      const claudeModels = AVAILABLE_CLAUDE_MODEL_ALIASES.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        family: m.family,
      }));

      const codexModels = Object.entries(CODEX_MODEL_METADATA).map(([id, meta]) => ({
        id,
        displayName: meta.name,
        description: meta.description,
        status: meta.status,
        availability: meta.availability,
      }));

      const copilotModels = Object.entries(COPILOT_MODEL_METADATA).map(([id, meta]) => ({
        id,
        displayName: meta.name,
        description: meta.description,
        provider: meta.provider,
      }));

      // Note: Gemini's live list comes from the Google API (per-user API key).
      // We surface the hardcoded fallback so agents have *something* to pass —
      // but more recent models may exist on the user's account.
      const geminiModels = Object.entries(GEMINI_MODELS).map(([id, meta]) => ({
        id,
        displayName: meta.name,
        description: meta.description,
        useCase: meta.useCase,
      }));

      const all = {
        'claude-code': {
          default: DEFAULT_CLAUDE_MODEL,
          models: claudeModels,
          note: 'Claude models are also fetched live via /claude-models (uses the Anthropic Models API). This is the static fallback.',
        },
        codex: {
          default: DEFAULT_CODEX_MODEL,
          models: codexModels,
          note: 'Latest models are listed first; omit modelConfig to use the default. Current models are supported defaults; older entries marked provider-dependent may vary by Codex account and are checked by Codex at startup. This is Agor’s known-model registry, not a dynamic Codex CLI/provider listing. Provider-specific IDs absent from this list must be passed with mode "exact". Known unsupported legacy aliases are omitted.',
        },
        gemini: {
          default: DEFAULT_GEMINI_MODEL,
          models: geminiModels,
          note: 'Gemini models are normally fetched live from the Google API per-user. This is the static fallback list — newer models may exist.',
        },
        opencode: {
          default: null,
          models: [],
          note: 'OpenCode models are provider-specific and are discovered after selecting a provider. Pass both modelConfig.provider and modelConfig.model from the OpenCode provider catalog.',
        },
        copilot: {
          default: DEFAULT_COPILOT_MODEL,
          models: copilotModels,
          note: "Copilot models are also fetched live via /copilot-models (uses the SDK's listModels()). This is the static fallback — BYOK-configured models may not appear here.",
        },
        cursor: {
          default: DEFAULT_CURSOR_MODEL,
          models: [
            {
              id: DEFAULT_CURSOR_MODEL,
              displayName: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].displayName,
              description: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].description,
            },
          ],
          note: "Cursor models are also fetched live via /cursor-models (uses @cursor/sdk's Cursor.models.list()). This is the static fallback — account-specific models may not appear here.",
        },
      } satisfies Record<
        AgenticToolName,
        { default: string | null; models: unknown[]; note: string }
      >;

      if (args.agenticTool) {
        return textResult({ [args.agenticTool]: all[args.agenticTool] });
      }
      return textResult(all);
    }
  );
}
