/**
 * MCP HTTP Routes
 *
 * Exposes MCP server via HTTP endpoint for Claude Agent SDK.
 * Uses session tokens for authentication.
 */

import type { Application } from '@agor/core/feathers';
import type { AgenticToolName } from '@agor/core/types';
import { normalizeOptionalHttpUrl } from '@agor/core/utils/url';
import type { Request, Response } from 'express';
import type { ReposServiceImpl, SessionsServiceImpl } from '../declarations.js';
import { validateSessionToken } from './tokens.js';

const WORKTREE_NAME_PATTERN = /^[a-z0-9-]+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function coerceString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Setup MCP routes on FeathersJS app
 */
export function setupMCPRoutes(app: Application): void {
  // MCP endpoint: POST /mcp
  // Expects: sessionToken query param
  // Returns: MCP JSON-RPC response

  // Use Express middleware directly
  const handler = async (req: Request, res: Response) => {
    try {
      console.log(`🔌 Incoming MCP request: ${req.method} /mcp`);
      console.log(`   Headers:`, JSON.stringify(req.headers).substring(0, 300));
      console.log(`   Query params:`, req.query);
      console.log(`   Body:`, JSON.stringify(req.body).substring(0, 200));

      // Extract session token from query params
      const sessionToken = req.query.sessionToken as string | undefined;

      if (!sessionToken) {
        console.warn('⚠️  MCP request missing sessionToken');
        return res.status(401).json({
          jsonrpc: '2.0',
          id: req.body.id,
          error: {
            code: -32001,
            message: 'Authentication required: session token must be provided in query params',
          },
        });
      }

      // Validate token and extract context
      const context = await validateSessionToken(app, sessionToken);
      if (!context) {
        console.warn('⚠️  Invalid MCP session token');
        return res.status(401).json({
          jsonrpc: '2.0',
          id: req.body.id,
          error: {
            code: -32001,
            message: 'Invalid or expired session token',
          },
        });
      }

      console.log(
        `🔌 MCP request authenticated (user: ${context.userId.substring(0, 8)}, session: ${context.sessionId.substring(0, 8)})`
      );

      // Handle the MCP request
      // The SDK expects JSON-RPC format in request body
      const mcpRequest = req.body;

      // Process request based on method
      let mcpResponse: unknown;

      if (mcpRequest.method === 'initialize') {
        // MCP initialization handshake
        console.log(`🔌 MCP initialize request from session ${context.sessionId.substring(0, 8)}`);
        mcpResponse = {
          protocolVersion: mcpRequest.params.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'agor',
            version: '0.1.0',
          },
        };
        console.log(
          `✅ MCP initialized successfully (protocol: ${(mcpResponse as { protocolVersion: string }).protocolVersion})`
        );
      } else if (mcpRequest.method === 'tools/list') {
        // Return list of available tools
        console.log(`🔧 MCP tools/list request from session ${context.sessionId.substring(0, 8)}`);
        mcpResponse = {
          tools: [
            // Session tools
            {
              name: 'agor_sessions_list',
              description: 'List all sessions accessible to the current user',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Maximum number of sessions to return (default: 50)',
                  },
                  status: {
                    type: 'string',
                    enum: ['idle', 'running', 'completed', 'failed'],
                    description: 'Filter by session status',
                  },
                  boardId: {
                    type: 'string',
                    description: 'Filter sessions by board ID (UUIDv7 or short ID)',
                  },
                  worktreeId: {
                    type: 'string',
                    description: 'Filter sessions by worktree ID',
                  },
                },
              },
            },
            {
              name: 'agor_sessions_get',
              description:
                'Get detailed information about a specific session, including genealogy and current state',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID (UUIDv7 or short ID like 01a1b2c3)',
                  },
                },
                required: ['sessionId'],
              },
            },
            {
              name: 'agor_sessions_get_current',
              description:
                'Get information about the current session (the one making this MCP call). Useful for introspection.',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'agor_sessions_spawn',
              description:
                'Spawn a child session (subsession) for delegating work to another agent. Creates a new session, executes the prompt, and tracks genealogy.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description: 'The prompt/task for the subsession agent to execute',
                  },
                  title: {
                    type: 'string',
                    description:
                      'Optional title for the session (defaults to first 100 chars of prompt)',
                  },
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'cursor', 'codex', 'gemini'],
                    description:
                      'Which agent to use for the subsession (defaults to same as parent)',
                  },
                  taskId: {
                    type: 'string',
                    description: 'Optional task ID to link the spawned session to',
                  },
                },
                required: ['prompt'],
              },
            },

            // Worktree tools
            {
              name: 'agor_worktrees_get',
              description:
                'Get detailed information about a worktree, including path, branch, and git state',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID (UUIDv7 or short ID)',
                  },
                },
                required: ['worktreeId'],
              },
            },
            {
              name: 'agor_worktrees_list',
              description: 'List all worktrees in a repository',
              inputSchema: {
                type: 'object',
                properties: {
                  repoId: {
                    type: 'string',
                    description: 'Repository ID to filter by',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_worktrees_create',
              description:
                'Create a worktree (and optional branch) for a repository, with optional board/issue/PR links',
              inputSchema: {
                type: 'object',
                properties: {
                  repoId: {
                    type: 'string',
                    description: 'Repository ID where the worktree will be created',
                  },
                  worktreeName: {
                    type: 'string',
                    description:
                      'Slug name for the worktree directory (lowercase letters, numbers, hyphens)',
                  },
                  ref: {
                    type: 'string',
                    description:
                      'Git ref to checkout. Defaults to the worktree name when creating a new branch.',
                  },
                  createBranch: {
                    type: 'boolean',
                    description:
                      'Whether to create a new branch. Defaults to true unless ref is a commit SHA.',
                  },
                  sourceBranch: {
                    type: 'string',
                    description:
                      'Base branch when creating a new branch (defaults to the repo default branch).',
                  },
                  pullLatest: {
                    type: 'boolean',
                    description:
                      'Pull latest from remote before creating the branch (defaults to true for new branches).',
                  },
                  boardId: {
                    type: 'string',
                    description:
                      "Board ID to immediately place the worktree on (positions to default coordinates). If not specified, defaults to the current session's board.",
                  },
                  issueUrl: {
                    type: 'string',
                    description: 'Issue URL to associate with the worktree.',
                  },
                  pullRequestUrl: {
                    type: 'string',
                    description: 'Pull request URL to associate with the worktree.',
                  },
                },
                required: ['repoId', 'worktreeName'],
              },
            },

            // Board tools
            {
              name: 'agor_boards_get',
              description: 'Get information about a board, including zones and layout',
              inputSchema: {
                type: 'object',
                properties: {
                  boardId: {
                    type: 'string',
                    description: 'Board ID (UUIDv7 or short ID)',
                  },
                },
                required: ['boardId'],
              },
            },
            {
              name: 'agor_boards_list',
              description: 'List all boards accessible to the current user',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },

            // Task tools
            {
              name: 'agor_tasks_list',
              description: 'List tasks (user prompts) in a session',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to get tasks from',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_tasks_get',
              description: 'Get detailed information about a specific task',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: {
                    type: 'string',
                    description: 'Task ID (UUIDv7 or short ID)',
                  },
                },
                required: ['taskId'],
              },
            },

            // User tools
            {
              name: 'agor_users_list',
              description: 'List all users in the system',
              inputSchema: {
                type: 'object',
                properties: {
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_users_get',
              description: 'Get detailed information about a specific user',
              inputSchema: {
                type: 'object',
                properties: {
                  userId: {
                    type: 'string',
                    description: 'User ID (UUIDv7)',
                  },
                },
                required: ['userId'],
              },
            },
            {
              name: 'agor_users_get_current',
              description:
                'Get information about the current authenticated user (the user associated with this MCP session)',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
            {
              name: 'agor_users_update_current',
              description:
                'Update the current user profile (name, emoji, avatar, preferences). Can only update own profile.',
              inputSchema: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Display name',
                  },
                  emoji: {
                    type: 'string',
                    description: 'User emoji (single emoji character)',
                  },
                  avatar: {
                    type: 'string',
                    description: 'Avatar URL',
                  },
                  preferences: {
                    type: 'object',
                    description: 'User preferences (JSON object)',
                  },
                },
              },
            },
            {
              name: 'agor_user_create',
              description:
                'Create a new user account. Requires email and password. Optionally set name, emoji, avatar, and role.',
              inputSchema: {
                type: 'object',
                properties: {
                  email: {
                    type: 'string',
                    description: 'User email address (must be unique)',
                  },
                  password: {
                    type: 'string',
                    description: 'User password (will be hashed)',
                  },
                  name: {
                    type: 'string',
                    description: 'Display name (optional)',
                  },
                  emoji: {
                    type: 'string',
                    description: 'User emoji for visual identity (optional, single emoji character)',
                  },
                  avatar: {
                    type: 'string',
                    description: 'Avatar URL (optional)',
                  },
                  role: {
                    type: 'string',
                    enum: ['owner', 'admin', 'member', 'viewer'],
                    description:
                      'User role (optional, defaults to "member"). Roles: owner=full system access, admin=manage most resources, member=standard user, viewer=read-only',
                  },
                },
                required: ['email', 'password'],
              },
            },
          ],
        };
      } else if (mcpRequest.method === 'notifications/initialized') {
        // Client notifying us that initialization is complete
        console.log(
          `📬 MCP notifications/initialized from session ${context.sessionId.substring(0, 8)}`
        );
        // No response needed for notifications
        return res.status(204).send();
      } else if (mcpRequest.method === 'tools/call') {
        // Handle tool call
        const { name, arguments: args } = mcpRequest.params || {};
        console.log(`🔧 MCP tool call: ${name}`);
        console.log(`   Arguments:`, JSON.stringify(args || {}).substring(0, 200));
        const baseServiceParams = {
          user: context.userId ? { user_id: context.userId } : undefined,
          authenticated: true,
        };

        // Session tools
        if (name === 'agor_sessions_list') {
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;
          if (args?.status) query.status = args.status;
          if (args?.boardId) query.board_id = args.boardId;
          if (args?.worktreeId) query.worktree_id = args.worktreeId;

          const sessions = await app.service('sessions').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(sessions, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_get') {
          if (!args?.sessionId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: sessionId is required',
              },
            });
          }

          const session = await app.service('sessions').get(args.sessionId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_get_current') {
          // Get current session using token context
          const session = await app.service('sessions').get(context.sessionId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_spawn') {
          // Spawn a child session (subsession)
          if (!args?.prompt) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: prompt is required',
              },
            });
          }

          const spawnData: {
            prompt: string;
            title?: string;
            agentic_tool?: AgenticToolName;
            task_id?: string;
          } = {
            prompt: args.prompt,
          };

          if (args.title) {
            spawnData.title = args.title;
          }

          if (args.agenticTool) {
            spawnData.agentic_tool = args.agenticTool as AgenticToolName;
          }

          if (args.taskId) {
            spawnData.task_id = args.taskId;
          }

          // Call spawn method on sessions service
          console.log(`🌱 MCP spawning subsession from ${context.sessionId.substring(0, 8)}`);
          const childSession = await (
            app.service('sessions') as unknown as SessionsServiceImpl
          ).spawn(context.sessionId, spawnData, baseServiceParams);
          console.log(`✅ Subsession created: ${childSession.session_id.substring(0, 8)}`);

          // Trigger prompt execution by directly calling the prompt service endpoint
          // This ensures events are broadcast properly via WebSockets
          console.log(
            `🚀 Triggering prompt execution for subsession ${childSession.session_id.substring(0, 8)}`
          );

          // Call the prompt endpoint as a FeathersJS service (not HTTP fetch)
          // This uses the same event emission context and ensures WebSocket broadcasting
          const promptResponse = await app.service('/sessions/:id/prompt').create(
            {
              prompt: args.prompt,
              permissionMode: childSession.permission_config?.mode || 'acceptEdits',
              stream: true,
            },
            {
              ...baseServiceParams,
              route: { id: childSession.session_id },
            }
          );

          console.log(`✅ Prompt execution started: task ${promptResponse.taskId.substring(0, 8)}`);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session: childSession,
                    taskId: promptResponse.taskId,
                    status: promptResponse.status,
                    note: 'Subsession created and prompt execution started in background.',
                  },
                  null,
                  2
                ),
              },
            ],
          };

          // Worktree tools
        } else if (name === 'agor_worktrees_get') {
          if (!args?.worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktree = await app.service('worktrees').get(args.worktreeId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(worktree, null, 2),
              },
            ],
          };
        } else if (name === 'agor_worktrees_list') {
          const query: Record<string, unknown> = {};
          if (args?.repoId) query.repo_id = args.repoId;
          if (args?.limit) query.$limit = args.limit;

          const worktrees = await app.service('worktrees').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(worktrees, null, 2),
              },
            ],
          };
        } else if (name === 'agor_worktrees_create') {
          const repoId = coerceString(args?.repoId);
          if (!repoId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: repoId is required',
              },
            });
          }

          const worktreeName = coerceString(args?.worktreeName);
          if (!worktreeName) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeName is required',
              },
            });
          }

          if (!WORKTREE_NAME_PATTERN.test(worktreeName)) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: worktreeName must use lowercase letters, numbers, or hyphens',
              },
            });
          }

          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          let repo: unknown;
          try {
            repo = await reposService.get(repoId);
          } catch {
            return res.status(404).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: `Repository ${repoId} not found`,
              },
            });
          }
          const defaultBranch =
            coerceString((repo as { default_branch?: unknown }).default_branch) ?? 'main';

          let createBranch = typeof args?.createBranch === 'boolean' ? args.createBranch : true;
          let ref = coerceString(args?.ref);
          let sourceBranch = coerceString(args?.sourceBranch);
          let pullLatest = typeof args?.pullLatest === 'boolean' ? args.pullLatest : undefined;

          if (ref && GIT_SHA_PATTERN.test(ref)) {
            createBranch = false;
            pullLatest = false;
            sourceBranch = undefined;
          }

          if (createBranch) {
            if (!ref) {
              ref = worktreeName;
            }
            if (!sourceBranch) {
              sourceBranch = defaultBranch;
            }
            if (pullLatest === undefined) {
              pullLatest = true;
            }
          } else {
            if (!ref) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: ref is required when createBranch is false',
                },
              });
            }
            sourceBranch = undefined;
            if (pullLatest === undefined) {
              pullLatest = false;
            }
          }

          // Default to current session's board if not specified
          let boardId = coerceString(args?.boardId);
          if (!boardId) {
            const currentSession = await app.service('sessions').get(context.sessionId);
            boardId = currentSession.board_id ?? undefined;
          }

          let issueUrl: string | undefined;
          let pullRequestUrl: string | undefined;

          try {
            issueUrl = normalizeOptionalHttpUrl(args?.issueUrl, 'issueUrl');
            pullRequestUrl = normalizeOptionalHttpUrl(args?.pullRequestUrl, 'pullRequestUrl');
          } catch (validationError) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  validationError instanceof Error
                    ? validationError.message
                    : 'Invalid URL parameter',
              },
            });
          }

          const worktree = await reposService.createWorktree(
            repoId,
            {
              name: worktreeName,
              ref,
              createBranch,
              ...(pullLatest !== undefined ? { pullLatest } : {}),
              ...(sourceBranch ? { sourceBranch } : {}),
              ...(issueUrl ? { issue_url: issueUrl } : {}),
              ...(pullRequestUrl ? { pull_request_url: pullRequestUrl } : {}),
              ...(boardId ? { boardId } : {}),
            },
            baseServiceParams
          );

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(worktree, null, 2),
              },
            ],
          };

          // Board tools
        } else if (name === 'agor_boards_get') {
          if (!args?.boardId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: boardId is required',
              },
            });
          }

          const board = await app.service('boards').get(args.boardId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(board, null, 2),
              },
            ],
          };
        } else if (name === 'agor_boards_list') {
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;

          const boards = await app.service('boards').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(boards, null, 2),
              },
            ],
          };

          // Task tools
        } else if (name === 'agor_tasks_list') {
          const query: Record<string, unknown> = {};
          if (args?.sessionId) query.session_id = args.sessionId;
          if (args?.limit) query.$limit = args.limit;

          const tasks = await app.service('tasks').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(tasks, null, 2),
              },
            ],
          };
        } else if (name === 'agor_tasks_get') {
          if (!args?.taskId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: taskId is required',
              },
            });
          }

          const task = await app.service('tasks').get(args.taskId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(task, null, 2),
              },
            ],
          };

          // User tools
        } else if (name === 'agor_users_list') {
          const query: Record<string, unknown> = {};
          if (args?.limit) query.$limit = args.limit;

          const users = await app.service('users').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(users, null, 2),
              },
            ],
          };
        } else if (name === 'agor_users_get') {
          if (!args?.userId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: userId is required',
              },
            });
          }

          const user = await app.service('users').get(args.userId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(user, null, 2),
              },
            ],
          };
        } else if (name === 'agor_users_get_current') {
          // Get current user from context (authenticated via MCP token)
          const user = await app.service('users').get(context.userId);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(user, null, 2),
              },
            ],
          };
        } else if (name === 'agor_users_update_current') {
          // Update current user profile
          // Only allow updating name, emoji, avatar, preferences
          const updateData: Record<string, unknown> = {};
          if (args?.name !== undefined) updateData.name = args.name;
          if (args?.emoji !== undefined) updateData.emoji = args.emoji;
          if (args?.avatar !== undefined) updateData.avatar = args.avatar;
          if (args?.preferences !== undefined) updateData.preferences = args.preferences;

          const updatedUser = await app.service('users').patch(context.userId, updateData);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(updatedUser, null, 2),
              },
            ],
          };
        } else if (name === 'agor_user_create') {
          // Create a new user
          if (!args?.email) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: email is required',
              },
            });
          }

          if (!args?.password) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: password is required',
              },
            });
          }

          // Build user creation data
          const createData: Record<string, unknown> = {
            email: args.email,
            password: args.password,
          };

          // Add optional fields
          if (args?.name !== undefined) createData.name = args.name;
          if (args?.emoji !== undefined) createData.emoji = args.emoji;
          if (args?.avatar !== undefined) createData.avatar = args.avatar;
          if (args?.role !== undefined) createData.role = args.role;

          const newUser = await app.service('users').create(createData);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(newUser, null, 2),
              },
            ],
          };
        } else {
          return res.status(400).json({
            jsonrpc: '2.0',
            id: mcpRequest.id,
            error: {
              code: -32601,
              message: `Unknown tool: ${name}`,
            },
          });
        }
      } else {
        return res.status(400).json({
          error: 'Unknown method',
          message: `Method ${mcpRequest.method} not supported`,
        });
      }

      // Return MCP JSON-RPC response
      return res.json({
        jsonrpc: '2.0',
        id: mcpRequest.id,
        result: mcpResponse,
      });
    } catch (error) {
      console.error('❌ MCP request failed:', error);
      return res.status(500).json({
        error: 'Internal error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Register as Express POST route
  // @ts-expect-error - FeathersJS app extends Express
  app.post('/mcp', handler);

  console.log('✅ MCP routes registered at POST /mcp');
}
