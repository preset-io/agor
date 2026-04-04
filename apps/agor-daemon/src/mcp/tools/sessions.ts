import { WorktreeRepository, type WorktreeWithZoneAndSessions } from '@agor/core/db';
import {
  type AgenticToolName,
  type Board,
  getSessionType,
  type Session,
  type SessionType,
  type ZoneBoardObject,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionsServiceImpl } from '../../declarations.js';
import type { SessionParams } from '../../services/sessions.js';
import { ensureCanPromptSession } from '../../utils/worktree-authorization.js';
import type { McpContext } from '../server.js';
import { textResult } from '../server.js';

export function registerSessionTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_sessions_list
  server.registerTool(
    'agor_sessions_list',
    {
      description:
        'List all sessions accessible to the current user. Each session includes a `url` field with a clickable link to view the session in the UI.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        limit: z.number().optional().describe('Maximum number of sessions to return (default: 50)'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('Filter by session status'),
        boardId: z.string().optional().describe('Filter sessions by board ID (UUIDv7 or short ID)'),
        worktreeId: z.string().optional().describe('Filter sessions by worktree ID'),
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
            "Filter by session type. 'gateway' = sessions from messaging integrations (Slack, Discord, GitHub). 'scheduled' = sessions created by worktree schedules. 'agent' = manually created sessions (excludes gateway and scheduled)."
          ),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      // When sessionType is set, skip service-level pagination (it runs before our filter)
      // and apply the requested limit ourselves after filtering.
      const requestedLimit = args.limit;
      if (!args.sessionType && requestedLimit) query.$limit = requestedLimit;
      if (args.status) query.status = args.status;
      if (args.boardId) query.board_id = args.boardId;
      if (args.worktreeId) query.worktree_id = args.worktreeId;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const result = await ctx.app.service('sessions').find({ query, ...ctx.baseServiceParams });

      // Apply sessionType filter (post-query since custom_context/scheduled_from_worktree aren't in query schema)
      if (args.sessionType) {
        const targetType = args.sessionType as SessionType;
        const filterFn = (s: Session) => getSessionType(s) === targetType;
        const allData: Session[] = Array.isArray(result) ? result : result.data;
        const filtered = allData.filter(filterFn);
        const limited = requestedLimit ? filtered.slice(0, requestedLimit) : filtered;

        if (Array.isArray(result)) {
          return textResult(limited);
        }
        return textResult({ ...result, data: limited, total: filtered.length });
      }

      return textResult(result);
    }
  );

  // Tool 2: agor_sessions_get
  server.registerTool(
    'agor_sessions_get',
    {
      description:
        'Get detailed information about a specific session, including genealogy and current state. The response includes a `url` field with a clickable link to view the session in the UI.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID (UUIDv7 or short ID like 01a1b2c3)'),
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
      return textResult(session);
    }
  );

  // Tool 3: agor_sessions_get_current
  server.registerTool(
    'agor_sessions_get_current',
    {
      description:
        'Get information about the current session (the one making this MCP call). Returns session details plus denormalized worktree, repo, and board context — useful for introspection and getting IDs needed by other tools.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const currentSessionParams: SessionParams = {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
      };
      const session = await ctx.app
        .service('sessions')
        .get(ctx.sessionId, currentSessionParams as Parameters<SessionsServiceImpl['get']>[1]);

      // Denormalize worktree, repo, and board context
      let worktree: Record<string, unknown> | null = null;
      let repo: Record<string, unknown> | null = null;
      let board: Record<string, unknown> | null = null;

      if (session.worktree_id) {
        try {
          const wt = await ctx.app
            .service('worktrees')
            .get(session.worktree_id, ctx.baseServiceParams);
          worktree = {
            worktree_id: wt.worktree_id,
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
          // worktree may have been deleted
        }
      }

      return textResult({
        session,
        worktree,
        repo,
        board,
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
        'Get a lean orientation snapshot for the current session in ONE call. Returns deduplicated context: session identity, user, git state, worktree (zone, issue/PR, notes, environment), board (with zones), repo (slug, default branch), genealogy, and sibling sessions. Every field appears exactly once. Use get_current or entity-specific tools for full details.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        includeSiblings: z
          .boolean()
          .optional()
          .describe(
            'Include other active sessions in the same worktree (default: true). Set false to reduce response size.'
          ),
      }),
    },
    async (args) => {
      const includeSiblings = args.includeSiblings !== false;

      // Fetch session and user in parallel (no dependencies)
      const [session, user] = await Promise.all([
        ctx.app.service('sessions').get(ctx.sessionId, ctx.baseServiceParams),
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
        thinking_mode: session.model_config?.thinkingMode || null,

        // User (who is authenticated / who is prompting)
        user_name: user.name,
        user_email: user.email,
        user_role: user.role,
      };

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

      // Git state (flat)
      result.branch = session.git_state?.ref || null;
      result.base_sha = session.git_state?.base_sha || null;
      result.current_sha = session.git_state?.current_sha || null;

      if (session.worktree_id) {
        try {
          // worktrees.get returns WorktreeWithZoneAndSessions (enriched with zone info)
          const wt = (await ctx.app
            .service('worktrees')
            .get(session.worktree_id, ctx.baseServiceParams)) as WorktreeWithZoneAndSessions;

          // Worktree context (no IDs that duplicate other sections)
          result.worktree_id = wt.worktree_id;
          result.worktree_name = wt.name;
          result.worktree_path = wt.path;
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

          // Sibling sessions in the same worktree
          if (includeSiblings) {
            try {
              // Fetch 11 to guarantee 10 siblings after excluding current session
              const siblings = await ctx.app.service('sessions').find({
                query: {
                  worktree_id: session.worktree_id,
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
          // worktree may have been deleted
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
        'Spawn a child session (subsession) for delegating work to another agent. Inherits the current worktree and tracks parent-child genealogy. Use for subtasks like "run tests", "review this code", or "fix linting errors". Configuration is inherited from parent (same agent) or user defaults (different agent).',
      inputSchema: z.object({
        prompt: z.string().describe('The prompt/task for the subsession agent to execute'),
        title: z
          .string()
          .optional()
          .describe('Optional title for the session (defaults to first 100 chars of prompt)'),
        agenticTool: z
          .enum(['claude-code', 'codex', 'gemini', 'opencode'])
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
        extraInstructions: z
          .string()
          .optional()
          .describe('Extra instructions appended to spawn prompt'),
        taskId: z.string().optional().describe('Optional task ID to link the spawned session to'),
        mcpServerIds: z
          .array(z.string())
          .optional()
          .describe(
            'MCP server IDs to attach. Overrides parent session inheritance. Omit to inherit from parent. Pass empty array for no MCPs.'
          ),
      }),
    },
    async (args) => {
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
      };

      const childSession = await (
        ctx.app.service('sessions') as unknown as SessionsServiceImpl
      ).spawn(ctx.sessionId, spawnData, ctx.baseServiceParams);

      const promptResponse = await ctx.app.service('/sessions/:id/prompt').create(
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
        session: childSession,
        taskId: promptResponse.taskId,
        status: promptResponse.status,
        note: 'Subsession created and prompt execution started in background.',
      });
    }
  );

  // Tool 5: agor_sessions_prompt
  server.registerTool(
    'agor_sessions_prompt',
    {
      description:
        'Prompt an existing session to continue work. Supports three modes: continue (append to conversation), fork (branch at decision point), or subsession (delegate to child agent). Configuration is inherited from parent session or user defaults.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID to prompt (UUIDv7 or short ID)'),
        prompt: z.string().describe('The prompt/task to execute'),
        mode: z
          .enum(['continue', 'fork', 'subsession'])
          .describe(
            'How to route the work: continue (add to existing session), fork (create sibling session), subsession (create child session)'
          ),
        agenticTool: z
          .enum(['claude-code', 'codex', 'gemini'])
          .optional()
          .describe(
            'Agent for subsession (subsession mode only, defaults to parent agent). Fork mode always uses parent agent.'
          ),
        title: z.string().optional().describe('Session title (for fork/subsession only)'),
        taskId: z.string().optional().describe('Fork/spawn point task ID (optional)'),
        mcpServerIds: z
          .array(z.string())
          .optional()
          .describe(
            'MCP server IDs for subsession mode. Overrides parent inheritance. Omit to inherit from parent. Pass empty array for no MCPs.'
          ),
      }),
    },
    async (args) => {
      const mode = args.mode;

      if (mode === 'continue') {
        const promptResponse = await ctx.app
          .service('/sessions/:id/prompt')
          .create(
            { prompt: args.prompt, stream: true },
            { ...ctx.baseServiceParams, route: { id: args.sessionId } }
          );

        if (promptResponse.queued) {
          return textResult({
            success: true,
            queued: true,
            queue_position: promptResponse.queue_position,
            note: 'Session is busy. Prompt has been queued and will execute automatically when the session becomes idle.',
          });
        }
        return textResult({
          success: true,
          taskId: promptResponse.taskId,
          status: promptResponse.status,
          note: 'Prompt added to existing session and execution started.',
        });
      } else if (mode === 'fork') {
        const forkData: { prompt: string; task_id?: string } = { prompt: args.prompt };
        if (args.taskId) forkData.task_id = args.taskId;

        const forkedSession = await (
          ctx.app.service('sessions') as unknown as SessionsServiceImpl
        ).fork(args.sessionId, forkData, ctx.baseServiceParams);

        if (args.title) {
          await ctx.app
            .service('sessions')
            .patch(forkedSession.session_id, { title: args.title }, ctx.baseServiceParams);
        }

        const updatedSession = await ctx.app
          .service('sessions')
          .get(forkedSession.session_id, ctx.baseServiceParams);

        const promptResponse = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.prompt,
            permissionMode: updatedSession.permission_config?.mode,
            stream: true,
          },
          { ...ctx.baseServiceParams, route: { id: forkedSession.session_id } }
        );

        return textResult({
          session: updatedSession,
          taskId: promptResponse.taskId,
          status: promptResponse.status,
          note: 'Forked session created and prompt execution started.',
        });
      } else if (mode === 'subsession') {
        const spawnData: Partial<import('@agor/core/types').SpawnConfig> = {
          prompt: args.prompt,
          mcpServerIds: args.mcpServerIds,
        };
        if (args.title) spawnData.title = args.title;
        if (args.agenticTool) spawnData.agent = args.agenticTool as AgenticToolName;
        if (args.taskId) spawnData.task_id = args.taskId;

        const childSession = await (
          ctx.app.service('sessions') as unknown as SessionsServiceImpl
        ).spawn(args.sessionId, spawnData, ctx.baseServiceParams);

        const promptResponse = await ctx.app.service('/sessions/:id/prompt').create(
          {
            prompt: args.prompt,
            permissionMode: childSession.permission_config?.mode,
            stream: true,
          },
          { ...ctx.baseServiceParams, route: { id: childSession.session_id } }
        );

        return textResult({
          session: childSession,
          taskId: promptResponse.taskId,
          status: promptResponse.status,
          note: 'Subsession created and prompt execution started.',
        });
      }

      return textResult({ error: `Unknown mode: ${mode}` });
    }
  );

  // Tool 6: agor_sessions_create
  server.registerTool(
    'agor_sessions_create',
    {
      description:
        'Create a new session in an existing worktree. Use for starting fresh work on a new task in the same codebase (e.g., new feature branch, separate investigation). Unlike spawn, this creates an independent session with no parent-child relationship. MCP servers are inherited from the worktree (if configured) or user defaults. Supports optional callbacks to notify the creating session when the new session completes.',
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID where the session will run (required)'),
        agenticTool: z
          .enum(['claude-code', 'codex', 'gemini'])
          .describe('Which agent to use for this session (required)'),
        title: z.string().optional().describe('Session title (optional)'),
        description: z.string().optional().describe('Session description (optional)'),
        contextFiles: z
          .array(z.string())
          .optional()
          .describe('Context file paths to load (optional)'),
        initialPrompt: z
          .string()
          .optional()
          .describe('Initial prompt to execute immediately after creating the session (optional)'),
        enableCallback: z
          .boolean()
          .optional()
          .describe(
            'Enable callback to the creating session when the new session completes (default: false). When true, the creating session will receive a completion notification.'
          ),
        callbackSessionId: z
          .string()
          .optional()
          .describe(
            'Session ID to notify on completion (defaults to the current/creating session when enableCallback is true)'
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
        mcpServerIds: z
          .array(z.string())
          .optional()
          .describe(
            'MCP server IDs to attach. Overrides worktree and user default inheritance. Omit to use worktree config > user defaults.'
          ),
      }),
    },
    async (args) => {
      const agenticTool = args.agenticTool as AgenticToolName;

      // Fetch user data to get unix_username
      const user = await ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams);

      // Get worktree to extract repo context
      const worktree = await ctx.app
        .service('worktrees')
        .get(args.worktreeId, ctx.baseServiceParams);

      // Get current git state
      const { getGitState, getCurrentBranch } = await import('@agor/core/git');
      const currentSha = await getGitState(worktree.path);
      const currentRef = await getCurrentBranch(worktree.path);

      // Determine permission mode from user defaults only
      const { getDefaultPermissionMode } = await import('@agor/core/types');
      const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');

      const userToolDefaults = user?.default_agentic_config?.[agenticTool];
      const requestedMode =
        userToolDefaults?.permissionMode || getDefaultPermissionMode(agenticTool);
      const permissionMode = mapPermissionMode(requestedMode, agenticTool);

      const permissionConfig: Record<string, unknown> = {
        mode: permissionMode,
        allowedTools: [],
      };

      if (
        agenticTool === 'codex' &&
        userToolDefaults?.codexSandboxMode &&
        userToolDefaults?.codexApprovalPolicy
      ) {
        permissionConfig.codex = {
          sandboxMode: userToolDefaults.codexSandboxMode,
          approvalPolicy: userToolDefaults.codexApprovalPolicy,
          networkAccess: userToolDefaults.codexNetworkAccess,
        };
      }

      let modelConfig: Record<string, unknown> | undefined;
      if (userToolDefaults?.modelConfig?.model) {
        modelConfig = {
          mode: userToolDefaults.modelConfig.mode || 'alias',
          model: userToolDefaults.modelConfig.model,
          updated_at: new Date().toISOString(),
          thinkingMode: userToolDefaults.modelConfig.thinkingMode,
          manualThinkingTokens: userToolDefaults.modelConfig.manualThinkingTokens,
        };
      }

      // MCP server inheritance: explicit param > worktree config > user defaults
      // An explicit empty array means "no MCPs" — does NOT fall through to worktree/user defaults.
      const mcpServerIds =
        args.mcpServerIds !== undefined
          ? args.mcpServerIds
          : worktree.mcp_server_ids && worktree.mcp_server_ids.length > 0
            ? worktree.mcp_server_ids
            : userToolDefaults?.mcpServerIds || [];

      // Build callback configuration for remote session callbacks
      const callbackConfig: Record<string, unknown> = {};

      // Determine the effective callback target session ID
      const effectiveCallbackSessionId = args.callbackSessionId || ctx.sessionId;
      const wantsCallback = args.enableCallback || args.callbackSessionId;

      // Validate user has prompt permission on the callback target session's worktree
      if (wantsCallback && args.callbackSessionId) {
        const worktreeRepo = new WorktreeRepository(ctx.db);
        await ensureCanPromptSession(args.callbackSessionId, ctx.userId, ctx.app, worktreeRepo);
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

      const sessionData: Record<string, unknown> = {
        worktree_id: args.worktreeId,
        agentic_tool: agenticTool,
        status: 'idle',
        title: args.title,
        description: args.description,
        created_by: ctx.userId,
        unix_username: user.unix_username,
        permission_config: permissionConfig,
        ...(modelConfig && { model_config: modelConfig }),
        ...(Object.keys(callbackConfig).length > 0 && { callback_config: callbackConfig }),
        contextFiles: args.contextFiles || [],
        git_state: {
          ref: currentRef,
          base_sha: currentSha,
          current_sha: currentSha,
        },
        genealogy: { children: [] },
        tasks: [],
      };

      const session = await ctx.app.service('sessions').create(sessionData, ctx.baseServiceParams);

      // Attach MCP servers (inherited from worktree or user defaults)
      if (mcpServerIds && mcpServerIds.length > 0) {
        for (const mcpServerId of mcpServerIds) {
          try {
            await ctx.app
              .service('session-mcp-servers')
              .create(
                { session_id: session.session_id, mcp_server_id: mcpServerId },
                ctx.baseServiceParams
              );
          } catch (error) {
            // Gracefully skip deleted/invalid MCP servers
            console.warn(
              `Skipped MCP server ${mcpServerId} for session ${session.session_id}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      // Execute initial prompt if provided
      let promptResponse = null;
      if (args.initialPrompt) {
        promptResponse = await ctx.app
          .service('/sessions/:id/prompt')
          .create(
            { prompt: args.initialPrompt, permissionMode, stream: true },
            { ...ctx.baseServiceParams, route: { id: session.session_id } }
          );
      }

      const callbackNote = callbackConfig.callback_session_id
        ? ` Callback will be sent to session ${(callbackConfig.callback_session_id as string).substring(0, 8)} on completion.`
        : '';

      return textResult({
        session,
        taskId: promptResponse?.taskId,
        note: args.initialPrompt
          ? `Session created and initial prompt execution started.${callbackNote}`
          : `Session created successfully.${callbackNote}`,
      });
    }
  );

  // Tool 7: agor_sessions_update
  server.registerTool(
    'agor_sessions_update',
    {
      description:
        'Update session metadata (title, description, status, archived). Useful for agents to self-document their work.',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        sessionId: z.string().describe('Session ID to update (UUIDv7 or short ID)'),
        title: z.string().optional().describe('New session title (optional)'),
        description: z.string().optional().describe('New session description (optional)'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('New session status (optional)'),
        archived: z
          .boolean()
          .optional()
          .describe('Set archive state. true to archive, false to unarchive (optional)'),
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

      if (Object.keys(updates).length === 0) {
        throw new Error(
          'At least one field (title, description, status, archived) must be provided'
        );
      }

      const session = await ctx.app
        .service('sessions')
        .patch(args.sessionId, updates, ctx.baseServiceParams);
      return textResult({ session, note: 'Session updated successfully.' });
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
        sessionId: z.string().describe('Session ID to archive (UUIDv7 or short ID)'),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Also archive all child sessions (forks and subsessions). Default: true.'),
      }),
    },
    async (args) => {
      const includeChildren = args.includeChildren !== false;
      const sessionsService = ctx.app.service('sessions') as unknown as SessionsServiceImpl;
      let archivedCount = 0;

      await ctx.app
        .service('sessions')
        .patch(
          args.sessionId,
          { archived: true, archived_reason: 'manual' },
          ctx.baseServiceParams
        );
      archivedCount++;

      if (includeChildren) {
        const collectDescendantIds = async (parentId: string): Promise<string[]> => {
          const gen = await sessionsService.getGenealogy(parentId, ctx.baseServiceParams);
          const ids: string[] = [];
          for (const child of gen.children) {
            ids.push(child.session_id);
            const nested = await collectDescendantIds(child.session_id);
            ids.push(...nested);
          }
          return ids;
        };

        const descendantIds = await collectDescendantIds(args.sessionId);
        for (const childId of descendantIds) {
          await ctx.app
            .service('sessions')
            .patch(childId, { archived: true, archived_reason: 'manual' }, ctx.baseServiceParams);
          archivedCount++;
        }
      }

      return textResult({
        success: true,
        archivedCount,
        message: `Archived ${archivedCount} session(s).`,
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
        sessionId: z.string().describe('Session ID to unarchive (UUIDv7 or short ID)'),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Also unarchive all child sessions (forks and subsessions). Default: true.'),
      }),
    },
    async (args) => {
      const includeChildren = args.includeChildren !== false;
      const sessionsService = ctx.app.service('sessions') as unknown as SessionsServiceImpl;
      let unarchivedCount = 0;

      await ctx.app
        .service('sessions')
        .patch(
          args.sessionId,
          { archived: false, archived_reason: undefined },
          ctx.baseServiceParams
        );
      unarchivedCount++;

      if (includeChildren) {
        const collectDescendantIds = async (parentId: string): Promise<string[]> => {
          const gen = await sessionsService.getGenealogy(parentId, ctx.baseServiceParams);
          const ids: string[] = [];
          for (const child of gen.children) {
            ids.push(child.session_id);
            const nested = await collectDescendantIds(child.session_id);
            ids.push(...nested);
          }
          return ids;
        };

        const descendantIds = await collectDescendantIds(args.sessionId);
        for (const childId of descendantIds) {
          await ctx.app
            .service('sessions')
            .patch(childId, { archived: false, archived_reason: undefined }, ctx.baseServiceParams);
          unarchivedCount++;
        }
      }

      return textResult({
        success: true,
        unarchivedCount,
        message: `Unarchived ${unarchivedCount} session(s).`,
      });
    }
  );

  // Tool 10: agor_sessions_bulk_archive
  server.registerTool(
    'agor_sessions_bulk_archive',
    {
      description:
        'Archive multiple sessions matching filter criteria. Supports filtering by session type (gateway/scheduled/agent), age, status, board, and worktree. Returns a dry-run preview by default — set dryRun to false to actually archive. Respects RBAC: sessions the current user cannot modify are skipped and reported as errors.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        sessionType: z
          .enum(['gateway', 'scheduled', 'agent'])
          .optional()
          .describe(
            "Filter by session type. 'gateway' = messaging integrations, 'scheduled' = cron-triggered, 'agent' = manually created."
          ),
        olderThanDays: z
          .number()
          .int()
          .positive()
          .max(365)
          .optional()
          .describe('Only archive sessions last updated more than this many days ago'),
        status: z
          .enum(['idle', 'running', 'completed', 'failed'])
          .optional()
          .describe('Only archive sessions with this status'),
        boardId: z.string().optional().describe('Only archive sessions on this board'),
        worktreeId: z.string().optional().describe('Only archive sessions in this worktree'),
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
      if (args.boardId) query.board_id = args.boardId;
      if (args.worktreeId) query.worktree_id = args.worktreeId;

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
            worktree_id: s.worktree_id,
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
}
