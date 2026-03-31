import { WorktreeRepository } from '@agor/core/db';
import type { AgenticToolName, BoardID, UUID, WorktreeID } from '@agor/core/types';
import { normalizeOptionalHttpUrl } from '@agor/core/utils/url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ReposServiceImpl, WorktreesServiceImpl } from '../../declarations.js';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

const WORKTREE_NAME_PATTERN = /^[a-z0-9-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function registerWorktreeTools(server: McpServer, ctx: McpContext): void {
  // Tool 1: agor_worktrees_get
  server.registerTool(
    'agor_worktrees_get',
    {
      description:
        'Get detailed information about a worktree, including path, branch, and git state',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID (UUIDv7 or short ID)'),
      }),
    },
    async (args) => {
      const worktree = await ctx.app.service('worktrees').get(args.worktreeId, {
        ...ctx.baseServiceParams,
        _include_sessions: true,
        _last_message_truncation_length: 500,
        // biome-ignore lint/suspicious/noExplicitAny: custom service params with underscored options
      } as any);
      return textResult(worktree);
    }
  );

  // Tool 2: agor_worktrees_list
  server.registerTool(
    'agor_worktrees_list',
    {
      description: 'List all worktrees in a repository',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        repoId: z.string().optional().describe('Repository ID to filter by'),
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
        includeArchived: z
          .boolean()
          .optional()
          .describe(
            'Include archived worktrees in results (default: false). By default, archived worktrees are excluded.'
          ),
        archived: z
          .boolean()
          .optional()
          .describe(
            'Filter to show ONLY archived worktrees. When true, returns only archived worktrees. Overrides includeArchived.'
          ),
      }),
    },
    async (args) => {
      const query: Record<string, unknown> = {};
      if (args.repoId) query.repo_id = args.repoId;
      if (args.limit) query.$limit = args.limit;
      if (args.archived === true) {
        query.archived = true;
      } else if (!args.includeArchived) {
        query.archived = false;
      }
      const worktrees = await ctx.app
        .service('worktrees')
        .find({ query, ...ctx.baseServiceParams });
      return textResult(worktrees);
    }
  );

  // Tool 3: agor_worktrees_create
  server.registerTool(
    'agor_worktrees_create',
    {
      description:
        'Create a worktree (and optional branch) for a repository, with required board placement. ' +
        'To fork from an existing branch with a unique worktree name, set sourceBranch to the base branch ' +
        'and worktreeName to your desired unique name (e.g., sourceBranch="issue-282", worktreeName="issue-282-review-1").',
      inputSchema: z.object({
        repoId: z.string().describe('Repository ID where the worktree will be created'),
        worktreeName: z
          .string()
          .describe(
            'Slug name for the worktree directory (lowercase letters, numbers, hyphens). ' +
              'If the name conflicts with an existing worktree, a numeric suffix is auto-appended (e.g., "my-feature-2"). ' +
              'Set autoSuffix=false to get an error on conflict instead.'
          ),
        boardId: z
          .string()
          .describe(
            'Board ID to place the worktree on (positions to default coordinates). Required to ensure worktrees are visible in the UI.'
          ),
        ref: z
          .string()
          .optional()
          .describe(
            'Git branch name to create or checkout. Defaults to worktreeName when creating a new branch. ' +
              'Set this to create a branch with a different name than the worktree directory. ' +
              'Example: worktreeName="review-1", ref="issue-282-review-1" creates directory "review-1" on branch "issue-282-review-1".'
          ),
        refType: z
          .enum(['branch', 'tag'])
          .optional()
          .describe('Type of ref (branch or tag). Defaults to branch.'),
        createBranch: z
          .boolean()
          .optional()
          .describe(
            'Whether to create a new branch (default: true). Set to false to checkout an existing branch. ' +
              'Auto-set to false when ref is a commit SHA.'
          ),
        pullLatest: z
          .boolean()
          .optional()
          .describe(
            'Pull latest from remote before creating the branch (defaults to true for new branches).'
          ),
        sourceBranch: z
          .string()
          .optional()
          .describe(
            'Base branch to fork from when creating a new branch (defaults to the repo default branch, usually "main"). ' +
              'The new branch will be created from the tip of this branch. ' +
              'Must exist on the remote (origin) or locally.'
          ),
        autoSuffix: z
          .boolean()
          .optional()
          .describe(
            'If worktreeName conflicts with an existing worktree, automatically append a numeric suffix ' +
              '(e.g., "my-feature" → "my-feature-2", "my-feature-3"). Defaults to true. Set to false to get an error on conflict instead.'
          ),
        issueUrl: z.string().optional().describe('Issue URL to associate with the worktree.'),
        pullRequestUrl: z
          .string()
          .optional()
          .describe('Pull request URL to associate with the worktree.'),
      }),
    },
    async (args) => {
      const repoId = coerceString(args.repoId)!;
      let worktreeName = coerceString(args.worktreeName)!;
      const originalName = worktreeName;
      const boardId = coerceString(args.boardId)!;
      const autoSuffix = typeof args.autoSuffix === 'boolean' ? args.autoSuffix : true;

      if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
        throw new Error('worktreeName must use lowercase letters, numbers, or hyphens');
      }

      const reposService = ctx.app.service('repos') as unknown as ReposServiceImpl;
      let repo: unknown;
      try {
        repo = await reposService.get(repoId);
      } catch {
        throw new Error(`Repository ${repoId} not found`);
      }

      // Auto-suffix: resolve name conflicts by appending -2, -3, etc.
      // Uses direct DB query to bypass Feathers pagination limits
      if (autoSuffix) {
        const worktreeRepo = new WorktreeRepository(ctx.db);
        const activeNames = await worktreeRepo.getActiveNamesByRepo(repoId as UUID);
        const existingNames = new Set(activeNames);

        if (existingNames.has(worktreeName)) {
          let suffix = 2;
          while (existingNames.has(`${worktreeName}-${suffix}`)) {
            suffix++;
          }
          worktreeName = `${worktreeName}-${suffix}`;
        }
      }

      const defaultBranch =
        coerceString((repo as { default_branch?: unknown }).default_branch) ?? 'main';
      const refType = (coerceString(args.refType) as 'branch' | 'tag') || 'branch';
      let createBranch = typeof args.createBranch === 'boolean' ? args.createBranch : true;
      let ref = coerceString(args.ref);
      let sourceBranch = coerceString(args.sourceBranch);
      let pullLatest = typeof args.pullLatest === 'boolean' ? args.pullLatest : undefined;

      if (ref && GIT_SHA_PATTERN.test(ref)) {
        createBranch = false;
        pullLatest = false;
        sourceBranch = undefined;
      }

      if (createBranch) {
        if (!ref) ref = worktreeName;
        if (!sourceBranch) sourceBranch = defaultBranch;
        if (pullLatest === undefined) pullLatest = true;
      } else {
        if (!ref) throw new Error('ref is required when createBranch is false');
        sourceBranch = undefined;
        if (pullLatest === undefined) pullLatest = false;
      }

      const issueUrl = normalizeOptionalHttpUrl(args.issueUrl, 'issueUrl');
      const pullRequestUrl = normalizeOptionalHttpUrl(args.pullRequestUrl, 'pullRequestUrl');

      // If auto-suffix changed the ref (branch name defaults to worktreeName), update it
      if (createBranch && !coerceString(args.ref) && worktreeName !== originalName) {
        ref = worktreeName;
      }

      const worktree = await reposService.createWorktree(
        repoId,
        {
          name: worktreeName,
          ref,
          createBranch,
          refType,
          ...(pullLatest !== undefined ? { pullLatest } : {}),
          ...(sourceBranch ? { sourceBranch } : {}),
          ...(issueUrl ? { issue_url: issueUrl } : {}),
          ...(pullRequestUrl ? { pull_request_url: pullRequestUrl } : {}),
          ...(boardId ? { boardId } : {}),
        },
        ctx.baseServiceParams
      );

      // Make it very clear when auto-suffix was applied
      if (worktreeName !== originalName) {
        return textResult({
          ...worktree,
          _note: `Name '${originalName}' was already taken. Created as '${worktreeName}' instead (autoSuffix applied).`,
        });
      }
      return textResult(worktree);
    }
  );

  // Tool 4: agor_worktrees_update
  server.registerTool(
    'agor_worktrees_update',
    {
      description:
        'Update metadata for an existing worktree (issue/PR URLs, notes, board placement, custom context)',
      annotations: { idempotentHint: true },
      inputSchema: z.object({
        worktreeId: z
          .string()
          .optional()
          .describe(
            'Worktree ID to update. Optional when calling from a session with a bound worktree.'
          ),
        issueUrl: z
          .string()
          .nullable()
          .optional()
          .describe('Issue URL to associate. Pass null to clear. Must be http(s) when provided.'),
        pullRequestUrl: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Pull request URL to associate. Pass null to clear. Must be http(s) when provided.'
          ),
        notes: z
          .string()
          .nullable()
          .optional()
          .describe(
            'Freeform notes about the worktree (markdown supported). Pass null or empty string to clear.'
          ),
        boardId: z
          .string()
          .nullable()
          .optional()
          .describe('Board ID to place this worktree on. Pass null to remove from any board.'),
        customContext: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional()
          .describe(
            'Custom context object for templates and automations. Pass null to clear existing context.'
          ),
        mcpServerIds: z
          .array(z.string())
          .nullable()
          .optional()
          .describe(
            'Default MCP server IDs for new sessions in this worktree. Sessions inherit these unless they explicitly specify their own. Pass null to clear.'
          ),
      }),
    },
    async (args) => {
      let resolvedWorktreeId = coerceString(args.worktreeId);
      if (!resolvedWorktreeId) {
        const currentSession = await ctx.app.service('sessions').get(ctx.sessionId);
        const sessionWorktreeId = currentSession.worktree_id;
        if (!sessionWorktreeId)
          throw new Error('worktreeId is required when current session is not bound to a worktree');
        resolvedWorktreeId = sessionWorktreeId;
      }

      let fieldsProvided = 0;
      const updates: Record<string, unknown> = {};

      if (args.issueUrl !== undefined) {
        fieldsProvided++;
        updates.issue_url =
          args.issueUrl === null
            ? null
            : (normalizeOptionalHttpUrl(args.issueUrl, 'issueUrl') ?? null);
      }
      if (args.pullRequestUrl !== undefined) {
        fieldsProvided++;
        updates.pull_request_url =
          args.pullRequestUrl === null
            ? null
            : (normalizeOptionalHttpUrl(args.pullRequestUrl, 'pullRequestUrl') ?? null);
      }
      if (args.notes !== undefined) {
        fieldsProvided++;
        if (args.notes === null) {
          updates.notes = null;
        } else {
          const trimmed = typeof args.notes === 'string' ? args.notes.trim() : '';
          updates.notes = trimmed.length > 0 ? trimmed : null;
        }
      }
      if (args.boardId !== undefined) {
        fieldsProvided++;
        updates.board_id = args.boardId === null ? null : coerceString(args.boardId);
      }
      if (args.customContext !== undefined) {
        fieldsProvided++;
        updates.custom_context = args.customContext === null ? null : args.customContext;
      }
      if (args.mcpServerIds !== undefined) {
        fieldsProvided++;
        updates.mcp_server_ids = args.mcpServerIds === null ? [] : args.mcpServerIds;
      }

      if (fieldsProvided === 0) throw new Error('provide at least one field to update');

      const worktree = await ctx.app
        .service('worktrees')
        // biome-ignore lint/suspicious/noExplicitAny: dynamic field updates from validated input
        .patch(resolvedWorktreeId as string, updates as any, ctx.baseServiceParams);
      return textResult({ worktree, note: 'Worktree metadata updated successfully.' });
    }
  );

  // Tool 5: agor_worktrees_set_zone
  server.registerTool(
    'agor_worktrees_set_zone',
    {
      description:
        "Pin a worktree to a zone on a board and optionally trigger the zone's prompt template. Calculates zone center position automatically and creates board association. If the zone has an 'always_new' trigger, a new session is automatically created and the prompt template is executed (matching UI drag-drop behavior). For 'show_picker' zones, use triggerTemplate + targetSessionId to send to an existing session.",
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID to pin to the zone (UUIDv7 or short ID)'),
        zoneId: z.string().describe('Zone ID to pin the worktree to (e.g., "zone-1770152859108")'),
        targetSessionId: z
          .string()
          .optional()
          .describe(
            'Session ID to send the zone trigger prompt to (required if triggerTemplate is true)'
          ),
        triggerTemplate: z
          .boolean()
          .optional()
          .describe(
            "Whether to execute the zone's prompt template after pinning (default: false). When true, sends the rendered template to targetSessionId. For zones with always_new triggers, this is handled automatically without needing to set this flag."
          ),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const zoneId = coerceString(args.zoneId)!;
      const targetSessionId = coerceString(args.targetSessionId);
      const triggerTemplate = args.triggerTemplate === true;

      console.log(`📍 MCP pinning worktree ${worktreeId.substring(0, 8)} to zone ${zoneId}`);

      // Get worktree to find its board
      const worktree = await ctx.app.service('worktrees').get(worktreeId, ctx.baseServiceParams);

      if (!worktree.board_id) {
        throw new Error('Worktree must be on a board before it can be pinned to a zone');
      }

      // Get board to find zone definition
      const board = await ctx.app.service('boards').get(worktree.board_id, ctx.baseServiceParams);

      const zone = board.objects?.[zoneId];
      if (!zone || zone.type !== 'zone') {
        throw new Error(`Zone ${zoneId} not found on board ${worktree.board_id}`);
      }

      // Calculate position RELATIVE to zone (not absolute canvas coordinates)
      // The UI expects relative positions and adds zone.x/zone.y when rendering
      const WORKTREE_CARD_WIDTH = 500;
      const WORKTREE_CARD_HEIGHT = 200;

      // Add jitter to prevent worktree cards from stacking exactly on top of each other
      // Use adaptive padding to keep cards away from zone edges when possible
      const DESIRED_PADDING = 80;

      // Calculate adaptive padding that respects zone constraints
      const maxPaddingX = Math.max(0, (zone.width - WORKTREE_CARD_WIDTH) / 2);
      const maxPaddingY = Math.max(0, (zone.height - WORKTREE_CARD_HEIGHT) / 2);
      const paddingX = Math.min(DESIRED_PADDING, maxPaddingX);
      const paddingY = Math.min(DESIRED_PADDING, maxPaddingY);

      // Calculate jitter range (clamped to >= 0 for small zones)
      const jitterRangeX = Math.max(0, zone.width - WORKTREE_CARD_WIDTH - 2 * paddingX);
      const jitterRangeY = Math.max(0, zone.height - WORKTREE_CARD_HEIGHT - 2 * paddingY);

      // Generate random position within valid area
      const relativeX = paddingX + Math.random() * jitterRangeX;
      const relativeY = paddingY + Math.random() * jitterRangeY;

      // Log warning if zone is smaller than card
      if (zone.width < WORKTREE_CARD_WIDTH || zone.height < WORKTREE_CARD_HEIGHT) {
        console.warn(
          `⚠️  Zone ${zoneId} is smaller than worktree card (${zone.width}x${zone.height} < ${WORKTREE_CARD_WIDTH}x${WORKTREE_CARD_HEIGHT}), card may overflow zone bounds`
        );
      }

      // Find or create board object for this worktree
      const boardObjectsService = ctx.app.service('board-objects') as unknown as {
        findByWorktreeId: (
          worktreeId: WorktreeID,
          params?: unknown
        ) => Promise<import('@agor/core/types').BoardEntityObject | null>;
        create: (
          data: unknown,
          params?: unknown
        ) => Promise<import('@agor/core/types').BoardEntityObject>;
        patch: (
          objectId: string,
          data: Partial<import('@agor/core/types').BoardEntityObject>,
          params?: unknown
        ) => Promise<import('@agor/core/types').BoardEntityObject>;
      };

      let boardObject: import('@agor/core/types').BoardEntityObject | null =
        await boardObjectsService.findByWorktreeId(worktreeId as WorktreeID, ctx.baseServiceParams);

      if (!boardObject) {
        // Create new board object
        boardObject = await boardObjectsService.create(
          {
            board_id: worktree.board_id as BoardID,
            worktree_id: worktreeId as WorktreeID,
            position: { x: relativeX, y: relativeY },
            zone_id: zoneId,
          },
          ctx.baseServiceParams
        );
      } else {
        // Update existing board object with zone and center position
        boardObject = await boardObjectsService.patch(
          boardObject.object_id,
          {
            position: { x: relativeX, y: relativeY },
            zone_id: zoneId,
          },
          ctx.baseServiceParams
        );
      }

      console.log(`✅ Worktree pinned to zone at relative position (${relativeX}, ${relativeY})`);

      // Determine whether to fire zone trigger
      let promptResult:
        | {
            taskId?: string;
            sessionId?: string;
            queued?: boolean;
            queue_position?: number;
            note: string;
          }
        | undefined;

      const hasZoneTrigger = zone.trigger?.template && zone.trigger.template.trim().length > 0;
      const isAlwaysNew = hasZoneTrigger && zone.trigger!.behavior === 'always_new';

      if (triggerTemplate && targetSessionId && hasZoneTrigger) {
        // Case 1: Explicit trigger to an existing session
        console.log(
          `🎯 Triggering zone prompt template for session ${targetSessionId.substring(0, 8)}`
        );

        const { renderTemplate } = await import('@agor/core/templates/handlebars-helpers');
        const templateContext = {
          worktree: {
            name: worktree.name,
            ref: worktree.ref,
            issue_url: worktree.issue_url,
            pull_request_url: worktree.pull_request_url,
            notes: worktree.notes,
            custom_context: worktree.custom_context,
          },
          board: {
            name: board.name,
            custom_context: board.custom_context,
          },
          zone: {
            label: zone.label,
            status: zone.status,
          },
        };

        const renderedPrompt = renderTemplate(zone.trigger!.template, templateContext);

        if (renderedPrompt) {
          const promptResponse = await ctx.app
            .service('/sessions/:id/prompt')
            .create(
              { prompt: renderedPrompt, stream: true },
              { ...ctx.baseServiceParams, route: { id: targetSessionId } }
            );

          if (promptResponse.queued) {
            promptResult = {
              queued: true,
              queue_position: promptResponse.queue_position,
              sessionId: targetSessionId,
              note: 'Session is busy. Zone trigger prompt has been queued.',
            };
            console.log(
              `📬 Zone trigger queued for session ${targetSessionId.substring(0, 8)} at position ${promptResponse.queue_position}`
            );
          } else {
            promptResult = {
              taskId: promptResponse.taskId,
              sessionId: targetSessionId,
              note: 'Zone trigger prompt sent to target session',
            };
            console.log(`✅ Zone trigger executed: task ${promptResponse.taskId.substring(0, 8)}`);
          }
        } else {
          promptResult = {
            note: 'Zone trigger template rendered to empty string (check template syntax)',
          };
          console.warn('⚠️  Zone trigger template rendered to empty string');
        }
      } else if (isAlwaysNew) {
        // Case 2: always_new — auto-create session and execute trigger
        console.log(
          `🎯 Zone has always_new trigger, auto-creating session for worktree ${worktreeId.substring(0, 8)}`
        );

        const { renderTemplate } = await import('@agor/core/templates/handlebars-helpers');
        const templateContext = {
          worktree: {
            name: worktree.name,
            ref: worktree.ref,
            issue_url: worktree.issue_url,
            pull_request_url: worktree.pull_request_url,
            notes: worktree.notes,
            custom_context: worktree.custom_context,
          },
          board: {
            name: board.name,
            custom_context: board.custom_context,
          },
          zone: {
            label: zone.label,
            status: zone.status,
          },
        };

        const renderedPrompt = renderTemplate(zone.trigger!.template, templateContext);

        if (renderedPrompt) {
          // Determine agent from trigger config
          const validAgents: AgenticToolName[] = ['claude-code', 'codex', 'gemini', 'opencode'];
          const rawAgent = zone.trigger!.agent;
          const agenticTool: AgenticToolName =
            rawAgent && validAgents.includes(rawAgent) ? rawAgent : 'claude-code';

          // Fetch user data for session creation context
          const user = await ctx.app.service('users').get(ctx.userId, ctx.baseServiceParams);

          // Get current git state
          const { getGitState, getCurrentBranch } = await import('@agor/core/git');
          const currentSha = await getGitState(worktree.path);
          const currentRef = await getCurrentBranch(worktree.path);

          // Resolve permission mode from user defaults
          const { getDefaultPermissionMode } = await import('@agor/core/types');
          const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
          const userToolDefaults = user?.default_agentic_config?.[agenticTool];
          const requestedMode =
            userToolDefaults?.permissionMode || getDefaultPermissionMode(agenticTool);
          const permissionMode = mapPermissionMode(requestedMode, agenticTool);

          // Build permission config
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

          // Build model config from user defaults
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

          // MCP server inheritance: worktree config > user defaults
          const mcpServerIds =
            worktree.mcp_server_ids && worktree.mcp_server_ids.length > 0
              ? worktree.mcp_server_ids
              : userToolDefaults?.mcpServerIds || [];

          // Create new session
          const sessionData: Record<string, unknown> = {
            worktree_id: worktreeId,
            agentic_tool: agenticTool,
            status: 'idle',
            description: `Session from zone "${zone.label}"`,
            created_by: ctx.userId,
            unix_username: user.unix_username,
            permission_config: permissionConfig,
            ...(modelConfig && { model_config: modelConfig }),
            git_state: {
              ref: currentRef,
              base_sha: currentSha,
              current_sha: currentSha,
            },
            genealogy: { children: [] },
            tasks: [],
            message_count: 0,
          };

          const newSession = await ctx.app
            .service('sessions')
            .create(sessionData, ctx.baseServiceParams);
          console.log(
            `✅ Auto-created session ${newSession.session_id.substring(0, 8)} (${agenticTool})`
          );

          // Attach MCP servers (inherited from worktree or user defaults)
          if (mcpServerIds.length > 0) {
            for (const mcpServerId of mcpServerIds) {
              try {
                await ctx.app.service('session-mcp-servers').create(
                  {
                    session_id: newSession.session_id,
                    mcp_server_id: mcpServerId,
                  },
                  ctx.baseServiceParams
                );
              } catch (error) {
                console.warn(
                  `Skipped MCP server ${mcpServerId} for session ${newSession.session_id}: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }
            console.log(`✅ Attached ${mcpServerIds.length} MCP servers`);
          }

          // Send rendered prompt to new session
          const promptResponse = await ctx.app
            .service('/sessions/:id/prompt')
            .create(
              { prompt: renderedPrompt, stream: true },
              { ...ctx.baseServiceParams, route: { id: newSession.session_id } }
            );

          promptResult = {
            taskId: promptResponse.taskId,
            sessionId: newSession.session_id,
            note: `always_new trigger: created session ${newSession.session_id.substring(0, 8)} (${agenticTool}) and sent prompt`,
          };
          console.log(`✅ Zone trigger executed: task ${promptResponse.taskId.substring(0, 8)}`);
        } else {
          promptResult = {
            note: 'Zone trigger template rendered to empty string (check template syntax)',
          };
          console.warn('⚠️  Zone trigger template rendered to empty string');
        }
      } else if (triggerTemplate && !hasZoneTrigger) {
        // Case 3: triggerTemplate requested but zone has no template configured
        promptResult = {
          note: `Zone "${zone.label}" has no trigger template configured. Add a trigger template to the zone via agor_boards_update first.`,
        };
      } else if (triggerTemplate && !targetSessionId) {
        // Case 3b: triggerTemplate requested but no targetSessionId on a non-always_new zone
        promptResult = {
          note: `Zone "${zone.label}" has a show_picker trigger. Provide a targetSessionId to send the prompt to, or use agor_sessions_create to make a new session first.`,
        };
      } else if (hasZoneTrigger && zone.trigger!.behavior === 'show_picker') {
        // Case 4: show_picker without explicit trigger — return trigger info for agent to decide
        promptResult = {
          note: `Zone "${zone.label}" has a show_picker trigger. Use triggerTemplate=true with a targetSessionId to execute, or use agor_sessions_create to make a new session first.`,
        };
      }

      return textResult({
        success: true,
        worktree_id: worktree.worktree_id,
        zone_id: zoneId,
        position: { x: relativeX, y: relativeY },
        board_object_id: boardObject.object_id,
        ...(promptResult ? { trigger: promptResult } : {}),
      });
    }
  );

  // Tool 6: agor_worktrees_archive
  server.registerTool(
    'agor_worktrees_archive',
    {
      description:
        'Archive a worktree (soft delete). Stops the environment if running, optionally cleans or deletes the filesystem, archives the worktree metadata and all its sessions, and removes it from the board. Use agor_worktrees_unarchive to restore.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID to archive (UUIDv7 or short ID)'),
        filesystemAction: z
          .enum(['preserved', 'cleaned', 'deleted'])
          .optional()
          .describe(
            'What to do with the worktree files on disk. "preserved" leaves files untouched, "cleaned" runs git clean -fdx (removes node_modules, builds, untracked files), "deleted" removes the entire worktree directory. Default: "cleaned".'
          ),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const filesystemAction =
        (args.filesystemAction as 'preserved' | 'cleaned' | 'deleted') || 'cleaned';
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      const result = await worktreesService.archiveOrDelete(
        worktreeId as WorktreeID,
        { metadataAction: 'archive', filesystemAction },
        ctx.baseServiceParams
      );
      return textResult({
        success: true,
        worktree: result,
        message: 'Worktree archived successfully.',
      });
    }
  );

  // Tool 7: agor_worktrees_unarchive
  server.registerTool(
    'agor_worktrees_unarchive',
    {
      description:
        'Restore a previously archived worktree. Optionally place it back on a board. Also unarchives all sessions that were archived as part of the worktree archival.',
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID to unarchive (UUIDv7 or short ID)'),
        boardId: z.string().optional().describe('Board ID to restore the worktree onto (optional)'),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const boardId = coerceString(args.boardId);
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      const result = await worktreesService.unarchive(
        worktreeId as WorktreeID,
        boardId ? { boardId: boardId as BoardID } : undefined,
        ctx.baseServiceParams
      );
      return textResult({
        success: true,
        worktree: result,
        message: 'Worktree unarchived successfully.',
      });
    }
  );

  // Tool 8: agor_worktrees_delete
  server.registerTool(
    'agor_worktrees_delete',
    {
      description:
        'Permanently delete a worktree and all its sessions, messages, and tasks. This action cannot be undone. Stops the environment if running and optionally removes files from disk.',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        worktreeId: z.string().describe('Worktree ID to delete (UUIDv7 or short ID)'),
        filesystemAction: z
          .enum(['preserved', 'deleted'])
          .optional()
          .describe(
            'What to do with the worktree files on disk. "preserved" leaves files untouched, "deleted" removes the entire worktree directory. Default: "deleted".'
          ),
      }),
    },
    async (args) => {
      const worktreeId = coerceString(args.worktreeId)!;
      const filesystemAction = (args.filesystemAction as 'preserved' | 'deleted') || 'deleted';
      const worktreesService = ctx.app.service('worktrees') as unknown as WorktreesServiceImpl;
      await worktreesService.archiveOrDelete(
        worktreeId as WorktreeID,
        { metadataAction: 'delete', filesystemAction },
        ctx.baseServiceParams
      );
      return textResult({
        success: true,
        worktree_id: worktreeId,
        message: 'Worktree permanently deleted.',
      });
    }
  );
}
