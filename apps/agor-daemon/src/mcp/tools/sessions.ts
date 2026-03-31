import { WorktreeRepository } from '@agor/core/db';
import type { AgenticToolName } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionsServiceImpl } from '../../declarations.js';
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
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.limit) query.$limit = args.limit;
      if (args.status) query.status = args.status;
      if (args.boardId) query.board_id = args.boardId;
      if (args.worktreeId) query.worktree_id = args.worktreeId;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const sessions = await ctx.app.service('sessions').find({ query });
      return textResult(sessions);
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
      const session = await ctx.app.service('sessions').get(args.sessionId, {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
        // biome-ignore lint/suspicious/noExplicitAny: custom service params with underscored options
      } as any);
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
      const session = await ctx.app.service('sessions').get(ctx.sessionId, {
        ...ctx.baseServiceParams,
        _include_last_message: true,
        _last_message_truncation_length: 500,
        // biome-ignore lint/suspicious/noExplicitAny: custom service params with underscored options
      } as any);

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
        message_count: 0,
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
}
