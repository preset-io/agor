/**
 * MCP HTTP Routes
 *
 * Exposes MCP server via HTTP endpoint for Claude Agent SDK.
 * Uses session tokens for authentication.
 */

import { extractSlugFromUrl, isValidGitUrl, isValidSlug } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { AgenticToolName, Board } from '@agor/core/types';
import { NotFoundError } from '@agor/core/utils/errors';
import { normalizeOptionalHttpUrl } from '@agor/core/utils/url';
import type { Request, Response } from 'express';
import type {
  AuthenticatedParams,
  AuthenticatedUser,
  ReposServiceImpl,
  SessionsServiceImpl,
} from '../declarations.js';
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
              description:
                'List all sessions accessible to the current user. Each session includes a `url` field with a clickable link to view the session in the UI.',
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
                'Get detailed information about a specific session, including genealogy and current state. The response includes a `url` field with a clickable link to view the session in the UI.',
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
                'Spawn a child session (subsession) for delegating work to another agent. Creates a new session, executes the prompt, and tracks genealogy. Session configuration is inherited from parent (same agent) or user defaults (different agent).',
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
                    enum: ['claude-code', 'codex', 'gemini', 'opencode'],
                    description:
                      'Which agent to use for the subsession (defaults to same as parent)',
                  },
                  enableCallback: {
                    type: 'boolean',
                    description: 'Enable callback to parent on completion (default: true)',
                  },
                  includeLastMessage: {
                    type: 'boolean',
                    description: "Include child's final result in callback (default: true)",
                  },
                  includeOriginalPrompt: {
                    type: 'boolean',
                    description: 'Include original spawn prompt in callback (default: false)',
                  },
                  extraInstructions: {
                    type: 'string',
                    description: 'Extra instructions appended to spawn prompt',
                  },
                  taskId: {
                    type: 'string',
                    description: 'Optional task ID to link the spawned session to',
                  },
                },
                required: ['prompt'],
              },
            },
            {
              name: 'agor_sessions_prompt',
              description:
                'Prompt an existing session to continue work. Supports three modes: continue (append to conversation), fork (branch at decision point), or subsession (delegate to child agent). Configuration is inherited from parent session or user defaults.',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to prompt (UUIDv7 or short ID)',
                  },
                  prompt: {
                    type: 'string',
                    description: 'The prompt/task to execute',
                  },
                  mode: {
                    type: 'string',
                    enum: ['continue', 'fork', 'subsession'],
                    description:
                      'How to route the work: continue (add to existing session), fork (create sibling session), subsession (create child session)',
                  },
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'codex', 'gemini'],
                    description:
                      'Agent for subsession (subsession mode only, defaults to parent agent). Fork mode always uses parent agent.',
                  },
                  title: {
                    type: 'string',
                    description: 'Session title (for fork/subsession only)',
                  },
                  taskId: {
                    type: 'string',
                    description: 'Fork/spawn point task ID (optional)',
                  },
                },
                required: ['sessionId', 'prompt', 'mode'],
              },
            },
            {
              name: 'agor_sessions_create',
              description:
                'Create a new session in an existing worktree. Useful for starting fresh work in the same codebase without forking or spawning. Session configuration (permissions, model, MCP servers) is automatically inherited from user defaults.',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID where the session will run (required)',
                  },
                  agenticTool: {
                    type: 'string',
                    enum: ['claude-code', 'codex', 'gemini'],
                    description: 'Which agent to use for this session (required)',
                  },
                  title: {
                    type: 'string',
                    description: 'Session title (optional)',
                  },
                  description: {
                    type: 'string',
                    description: 'Session description (optional)',
                  },
                  contextFiles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Context file paths to load (optional)',
                  },
                  initialPrompt: {
                    type: 'string',
                    description:
                      'Initial prompt to execute immediately after creating the session (optional)',
                  },
                },
                required: ['worktreeId', 'agenticTool'],
              },
            },
            {
              name: 'agor_sessions_update',
              description:
                'Update session metadata (title, description, status). Useful for agents to self-document their work.',
              inputSchema: {
                type: 'object',
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Session ID to update (UUIDv7 or short ID)',
                  },
                  title: {
                    type: 'string',
                    description: 'New session title (optional)',
                  },
                  description: {
                    type: 'string',
                    description: 'New session description (optional)',
                  },
                  status: {
                    type: 'string',
                    enum: ['idle', 'running', 'completed', 'failed'],
                    description: 'New session status (optional)',
                  },
                },
                required: ['sessionId'],
              },
            },

            // Repository tools
            {
              name: 'agor_repos_list',
              description: 'List all repositories accessible to the current user',
              inputSchema: {
                type: 'object',
                properties: {
                  slug: {
                    type: 'string',
                    description: 'Filter by repository slug',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                },
              },
            },
            {
              name: 'agor_repos_get',
              description: 'Get detailed information about a specific repository',
              inputSchema: {
                type: 'object',
                properties: {
                  repoId: {
                    type: 'string',
                    description: 'Repository ID (UUIDv7 or short ID)',
                  },
                },
                required: ['repoId'],
              },
            },
            {
              name: 'agor_repos_create_remote',
              description:
                'Clone a remote repository into Agor. Returns immediately with pending status - repository will be created asynchronously.',
              inputSchema: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    description:
                      'Git remote URL (https://github.com/user/repo.git or git@github.com:user/repo.git)',
                  },
                  slug: {
                    type: 'string',
                    description:
                      'URL-friendly slug for the repository in org/name format (e.g., "myorg/myapp"). Required.',
                  },
                  name: {
                    type: 'string',
                    description:
                      'Human-readable name for the repository. If not provided, defaults to the slug.',
                  },
                },
                required: ['url'],
              },
            },
            {
              name: 'agor_repos_create_local',
              description: 'Register an existing local git repository with Agor',
              inputSchema: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description:
                      'Absolute path to the local git repository. Supports ~ for home directory.',
                  },
                  slug: {
                    type: 'string',
                    description:
                      'URL-friendly slug for the repository (e.g., "local/myapp"). If not provided, will be auto-derived from the repository name.',
                  },
                },
                required: ['path'],
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
                'Create a worktree (and optional branch) for a repository, with required board placement',
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
                  boardId: {
                    type: 'string',
                    description:
                      'Board ID to place the worktree on (positions to default coordinates). Required to ensure worktrees are visible in the UI.',
                  },
                  ref: {
                    type: 'string',
                    description:
                      'Git ref to checkout. Defaults to the worktree name when creating a new branch.',
                  },
                  refType: {
                    type: 'string',
                    enum: ['branch', 'tag'],
                    description: 'Type of ref (branch or tag). Defaults to branch.',
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
                  issueUrl: {
                    type: 'string',
                    description: 'Issue URL to associate with the worktree.',
                  },
                  pullRequestUrl: {
                    type: 'string',
                    description: 'Pull request URL to associate with the worktree.',
                  },
                },
                required: ['repoId', 'worktreeName', 'boardId'],
              },
            },
            {
              name: 'agor_worktrees_update',
              description:
                'Update metadata for an existing worktree (issue/PR URLs, notes, board placement, custom context)',
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description:
                      'Worktree ID to update. Optional when calling from a session with a bound worktree.',
                  },
                  issueUrl: {
                    type: ['string', 'null'],
                    description:
                      'Issue URL to associate. Pass null to clear. Must be http(s) when provided.',
                  },
                  pullRequestUrl: {
                    type: ['string', 'null'],
                    description:
                      'Pull request URL to associate. Pass null to clear. Must be http(s) when provided.',
                  },
                  notes: {
                    type: ['string', 'null'],
                    description:
                      'Freeform notes about the worktree (markdown supported). Pass null or empty string to clear.',
                  },
                  boardId: {
                    type: ['string', 'null'],
                    description:
                      'Board ID to place this worktree on. Pass null to remove from any board.',
                  },
                  customContext: {
                    type: ['object', 'null'],
                    additionalProperties: true,
                    description:
                      'Custom context object for templates and automations. Pass null to clear existing context.',
                  },
                },
              },
            },
            {
              name: 'agor_worktrees_set_zone',
              description:
                "Pin a worktree to a zone on a board and optionally trigger the zone's prompt template. Calculates zone center position automatically and creates board association. If the zone has an 'always_new' trigger, a new session is automatically created and the prompt template is executed (matching UI drag-drop behavior). For 'show_picker' zones, use triggerTemplate + targetSessionId to send to an existing session.",
              inputSchema: {
                type: 'object',
                properties: {
                  worktreeId: {
                    type: 'string',
                    description: 'Worktree ID to pin to the zone (UUIDv7 or short ID)',
                  },
                  zoneId: {
                    type: 'string',
                    description: 'Zone ID to pin the worktree to (e.g., "zone-1770152859108")',
                  },
                  targetSessionId: {
                    type: 'string',
                    description:
                      'Session ID to send the zone trigger prompt to (required if triggerTemplate is true)',
                  },
                  triggerTemplate: {
                    type: 'boolean',
                    description:
                      "Whether to execute the zone's prompt template after pinning (default: false). When true, sends the rendered template to targetSessionId. For zones with always_new triggers, this is handled automatically without needing to set this flag.",
                  },
                },
                required: ['worktreeId', 'zoneId'],
              },
            },

            // Environment tools
            {
              name: 'agor_environment_start',
              description:
                'Start the environment for a worktree by running its configured start command',
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
              name: 'agor_environment_stop',
              description:
                'Stop the environment for a worktree by running its configured stop command',
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
              name: 'agor_environment_health',
              description:
                'Check the health status of a worktree environment by running its configured health command',
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
              name: 'agor_environment_logs',
              description:
                'Fetch recent logs from a worktree environment (non-streaming, last ~100 lines)',
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
              name: 'agor_environment_open_app',
              description: 'Open the application URL for a worktree environment in the browser',
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
              name: 'agor_environment_nuke',
              description:
                'Nuke the environment for a worktree (destructive operation - typically removes volumes and all data)',
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

            // Board tools
            {
              name: 'agor_boards_get',
              description:
                'Get information about a board, including zones and layout. The response includes a `url` field with a clickable link to view the board in the UI.',
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
              description:
                'List all boards accessible to the current user. Each board includes a `url` field with a clickable link to view the board in the UI.',
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
              name: 'agor_boards_update',
              description:
                'Update board metadata and manage zones/objects. Can update name, icon, background, and create/update zones for organizing worktrees. Zone objects have: type="zone", x, y, width, height, label, borderColor, backgroundColor, borderStyle (optional), trigger (optional: "always_new" auto-creates sessions, "show_picker" shows agent selection). Text objects have: type="text", x, y, text, fontSize, color. Markdown objects have: type="markdown", x, y, width, height, content.',
              inputSchema: {
                type: 'object',
                properties: {
                  boardId: {
                    type: 'string',
                    description: 'Board ID (UUIDv7 or short ID)',
                  },
                  name: {
                    type: 'string',
                    description: 'Board name (optional)',
                  },
                  description: {
                    type: 'string',
                    description: 'Board description (optional)',
                  },
                  icon: {
                    type: 'string',
                    description: 'Board icon/emoji (optional)',
                  },
                  color: {
                    type: 'string',
                    description: 'Board color (hex format, optional)',
                  },
                  backgroundColor: {
                    type: 'string',
                    description: 'Board background color (hex format, optional)',
                  },
                  slug: {
                    type: 'string',
                    description: 'URL-friendly slug (optional)',
                  },
                  customContext: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Custom context for templates (optional)',
                  },
                  upsertObjects: {
                    type: 'object',
                    additionalProperties: true,
                    description:
                      'Board objects to upsert (zones, text, markdown). Keys are object IDs, values are object data. ' +
                      'Zone objects: { type: "zone", x: number, y: number, width: number, height: number, label: string, ' +
                      'borderColor: string (hex), backgroundColor: string (hex), borderStyle?: "solid"|"dashed", ' +
                      'trigger?: { behavior: "always_new"|"show_picker", agent?: "claude-code"|"codex"|"gemini" } }. ' +
                      'Text objects: { type: "text", x: number, y: number, text: string }. ' +
                      'Markdown objects: { type: "markdown", x: number, y: number, content: string }.',
                  },
                  removeObjects: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of object IDs to remove from the board',
                  },
                },
                required: ['boardId'],
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
              name: 'agor_users_update',
              description:
                'Update any user account (admin operation). Only updates fields that are provided. Can update email, name, role, password, unix_username, must_change_password, emoji, avatar, and preferences.',
              inputSchema: {
                type: 'object',
                properties: {
                  userId: {
                    type: 'string',
                    description: 'User ID to update (UUIDv7 or short ID)',
                  },
                  email: {
                    type: 'string',
                    description: 'New email address (optional)',
                  },
                  name: {
                    type: 'string',
                    description: 'New display name (optional)',
                  },
                  password: {
                    type: 'string',
                    description: 'New password (optional, will be hashed)',
                  },
                  role: {
                    type: 'string',
                    enum: ['owner', 'admin', 'member', 'viewer'],
                    description: 'New user role (optional)',
                  },
                  unix_username: {
                    type: 'string',
                    description: 'New Unix username for shell access (optional)',
                  },
                  must_change_password: {
                    type: 'boolean',
                    description: 'Force user to change password on next login (optional)',
                  },
                  emoji: {
                    type: 'string',
                    description: 'User emoji (optional, single emoji character)',
                  },
                  avatar: {
                    type: 'string',
                    description: 'Avatar URL (optional)',
                  },
                  preferences: {
                    type: 'object',
                    description: 'User preferences (optional, JSON object)',
                  },
                },
                required: ['userId'],
              },
            },
            {
              name: 'agor_user_create',
              description:
                'Create a new user account. Requires email and password. Optionally set name, emoji, avatar, unix_username, must_change_password, and role.',
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
                    description:
                      'User emoji for visual identity (optional, single emoji character)',
                  },
                  avatar: {
                    type: 'string',
                    description: 'Avatar URL (optional)',
                  },
                  unix_username: {
                    type: 'string',
                    description:
                      'Unix username for shell access (optional, defaults to email prefix if not specified)',
                  },
                  must_change_password: {
                    type: 'boolean',
                    description:
                      'Force user to change password on first login (optional, defaults to false)',
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

            // Analytics tools
            {
              name: 'agor_analytics_leaderboard',
              description:
                'Get usage analytics leaderboard showing token and cost breakdown. Supports dynamic grouping by user, worktree, or repo (or combinations). Use groupBy parameter to control aggregation level.',
              inputSchema: {
                type: 'object',
                properties: {
                  userId: {
                    type: 'string',
                    description: 'Filter by user ID (optional)',
                  },
                  worktreeId: {
                    type: 'string',
                    description: 'Filter by worktree ID (optional)',
                  },
                  repoId: {
                    type: 'string',
                    description: 'Filter by repository ID (optional)',
                  },
                  startDate: {
                    type: 'string',
                    description: 'Filter by start date (ISO 8601 format, optional)',
                  },
                  endDate: {
                    type: 'string',
                    description: 'Filter by end date (ISO 8601 format, optional)',
                  },
                  groupBy: {
                    type: 'string',
                    enum: [
                      'user',
                      'worktree',
                      'repo',
                      'user,worktree',
                      'user,repo',
                      'worktree,repo',
                      'user,worktree,repo',
                    ],
                    description:
                      'Group by dimension(s). Examples: "user" for per-user totals, "worktree" for per-worktree, "user,worktree" for user+worktree breakdown (default: user,worktree,repo)',
                  },
                  sortBy: {
                    type: 'string',
                    enum: ['tokens', 'cost'],
                    description: 'Sort by tokens or cost (default: cost)',
                  },
                  sortOrder: {
                    type: 'string',
                    enum: ['asc', 'desc'],
                    description: 'Sort order ascending or descending (default: desc)',
                  },
                  limit: {
                    type: 'number',
                    description: 'Maximum number of results (default: 50)',
                  },
                  offset: {
                    type: 'number',
                    description: 'Number of results to skip for pagination (default: 0)',
                  },
                },
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

        // Fetch the authenticated user to get their role for permission checks
        let authenticatedUser: AuthenticatedUser | undefined;
        try {
          authenticatedUser = context.userId
            ? await app.service('users').get(context.userId)
            : undefined;
        } catch (error) {
          // If user doesn't exist (e.g., deleted after token was issued), treat as unauthorized
          if (error instanceof NotFoundError) {
            return res.status(401).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32001,
                message: 'Invalid or expired session token',
              },
            });
          }
          throw error;
        }

        const baseServiceParams: Pick<AuthenticatedParams, 'user' | 'authenticated'> = {
          user: authenticatedUser
            ? {
                user_id: authenticatedUser.user_id,
                email: authenticatedUser.email,
                role: authenticatedUser.role,
              }
            : undefined,
          authenticated: true,
        };

        // Session tools
        if (name === 'agor_sessions_list') {
          // Build query
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

          // Include last message in MCP session get calls
          // Pass enrichment flags at params root level to bypass Feathers query filtering
          const session = await app.service('sessions').get(args.sessionId, {
            ...baseServiceParams,
            _include_last_message: true,
            _last_message_truncation_length: 500,
            // biome-ignore lint/suspicious/noExplicitAny: Custom params bypass Feathers type system
          } as any);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(session, null, 2),
              },
            ],
          };
        } else if (name === 'agor_sessions_get_current') {
          // Get current session using token context with last message
          // Pass enrichment flags at params root level to bypass Feathers query filtering
          const session = await app.service('sessions').get(context.sessionId, {
            ...baseServiceParams,
            _include_last_message: true,
            _last_message_truncation_length: 500,
            // biome-ignore lint/suspicious/noExplicitAny: Custom params bypass Feathers type system
          } as any);
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

          // Build spawn config - only include fields we allow via MCP
          // Explicitly omit permissionMode, modelConfig, codex*, and mcpServerIds
          // These are managed via user defaults or inherited from parent
          const spawnData: Partial<import('@agor/core/types').SpawnConfig> = {
            prompt: args.prompt,
            title: args.title,
            agent: args.agenticTool as AgenticToolName | undefined,
            enableCallback: args.enableCallback,
            includeLastMessage: args.includeLastMessage,
            includeOriginalPrompt: args.includeOriginalPrompt,
            extraInstructions: args.extraInstructions,
            task_id: args.taskId,
          };

          // Call spawn method on sessions service
          console.log(`🌱 MCP spawning subsession from ${context.sessionId.substring(0, 8)}`);
          const childSession = await (
            app.service('sessions') as unknown as SessionsServiceImpl
          ).spawn(context.sessionId, spawnData, baseServiceParams);
          console.log(`✅ Subsession created: ${childSession.session_id.substring(0, 8)}`);

          // Trigger child execution (spawns start fresh by default - see query-builder.ts)
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
        } else if (name === 'agor_sessions_prompt') {
          // Prompt an existing session with routing mode
          if (!args?.sessionId || !args?.prompt || !args?.mode) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: sessionId, prompt, and mode are required',
              },
            });
          }

          const mode = args.mode as 'continue' | 'fork' | 'subsession';

          if (mode === 'continue') {
            // Mode: continue - add to existing conversation
            console.log(
              `➡️  MCP continuing session ${args.sessionId.substring(0, 8)} with new prompt`
            );

            const promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.prompt,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: args.sessionId },
              }
            );

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      taskId: promptResponse.taskId,
                      status: promptResponse.status,
                      note: 'Prompt added to existing session and execution started.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else if (mode === 'fork') {
            // Mode: fork - create sibling session
            console.log(`🔀 MCP forking session ${args.sessionId.substring(0, 8)}`);

            const forkData: {
              prompt: string;
              task_id?: string;
            } = {
              prompt: args.prompt,
            };

            if (args.taskId) {
              forkData.task_id = args.taskId;
            }

            // Call fork method on sessions service
            const forkedSession = await (
              app.service('sessions') as unknown as SessionsServiceImpl
            ).fork(args.sessionId, forkData, baseServiceParams);

            // Note: We no longer allow changing agenticTool in fork mode via MCP.
            // Fork inherits the same agent as parent. If you need a different agent,
            // use 'subsession' mode instead, which properly handles config for different tools.

            // Set custom title if provided
            if (args.title) {
              await app
                .service('sessions')
                .patch(forkedSession.session_id, { title: args.title }, baseServiceParams);
            }

            // Get updated session
            const updatedSession = await app
              .service('sessions')
              .get(forkedSession.session_id, baseServiceParams);

            // Trigger prompt execution
            console.log(`🚀 Triggering prompt execution for forked session`);
            const promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.prompt,
                permissionMode: updatedSession.permission_config?.mode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: forkedSession.session_id },
              }
            );

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      session: updatedSession,
                      taskId: promptResponse.taskId,
                      status: promptResponse.status,
                      note: 'Forked session created and prompt execution started.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else if (mode === 'subsession') {
            // Mode: subsession - spawn child session (reuse existing spawn logic)
            console.log(`🌱 MCP spawning subsession from ${args.sessionId.substring(0, 8)}`);

            const spawnData: Partial<import('@agor/core/types').SpawnConfig> = {
              prompt: args.prompt,
            };

            if (args.title) {
              spawnData.title = args.title;
            }

            if (args.agenticTool) {
              spawnData.agent = args.agenticTool as AgenticToolName;
            }

            if (args.taskId) {
              spawnData.task_id = args.taskId;
            }

            // Call spawn method on sessions service
            const childSession = await (
              app.service('sessions') as unknown as SessionsServiceImpl
            ).spawn(args.sessionId, spawnData, baseServiceParams);

            // Permission mode is inherited from spawn() method (parent session or user defaults)
            // No explicit override allowed via MCP to avoid complexity

            // Use childSession directly (no need to refetch)
            const updatedSession = childSession;

            // Trigger prompt execution (spawns start fresh by default - see query-builder.ts)
            console.log(`🚀 Triggering prompt execution for subsession`);
            const promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.prompt,
                permissionMode: updatedSession.permission_config?.mode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: childSession.session_id },
              }
            );

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      session: updatedSession,
                      taskId: promptResponse.taskId,
                      status: promptResponse.status,
                      note: 'Subsession created and prompt execution started.',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_sessions_create') {
          // Create a new session in an existing worktree
          if (!args?.worktreeId || !args?.agenticTool) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId and agenticTool are required',
              },
            });
          }

          console.log(`✨ MCP creating new session in worktree ${args.worktreeId.substring(0, 8)}`);

          // Fetch user data to get unix_username
          const user = await app.service('users').get(context.userId, baseServiceParams);

          // Get worktree to extract repo context
          const worktree = await app.service('worktrees').get(args.worktreeId, baseServiceParams);

          // Get current git state
          const { getGitState, getCurrentBranch } = await import('@agor/core/git');
          const currentSha = await getGitState(worktree.path);
          const currentRef = await getCurrentBranch(worktree.path);

          // Determine permission mode from user defaults only
          // MCP tools should not override user preferences - they're too complex for agents to manage
          const { getDefaultPermissionMode } = await import('@agor/core/types');
          const { mapPermissionMode } = await import('@agor/core/utils/permission-mode-mapper');
          const agenticTool = args.agenticTool as AgenticToolName;

          // Check user's default_agentic_config for this tool
          const userToolDefaults = user?.default_agentic_config?.[agenticTool];
          const requestedMode =
            userToolDefaults?.permissionMode || getDefaultPermissionMode(agenticTool);
          const permissionMode = mapPermissionMode(requestedMode, agenticTool);

          // Build permission config (including Codex-specific settings if applicable)
          const permissionConfig: Record<string, unknown> = {
            mode: permissionMode,
            allowedTools: [],
          };

          // Apply Codex-specific defaults if creating a Codex session
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

          // Build model config from user defaults (only if a model is specified)
          // Other fields like thinkingMode require a model context to be meaningful
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

          // Determine MCP server IDs from user defaults only
          const mcpServerIds = userToolDefaults?.mcpServerIds || [];

          // Create session
          const sessionData: Record<string, unknown> = {
            worktree_id: args.worktreeId,
            agentic_tool: agenticTool,
            status: 'idle',
            title: args.title,
            description: args.description,
            created_by: context.userId,
            unix_username: user.unix_username,
            permission_config: permissionConfig,
            ...(modelConfig && { model_config: modelConfig }),
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

          const session = await app.service('sessions').create(sessionData, baseServiceParams);
          console.log(`✅ Session created: ${session.session_id.substring(0, 8)}`);

          // Attach MCP servers from user defaults
          if (mcpServerIds && mcpServerIds.length > 0) {
            for (const mcpServerId of mcpServerIds) {
              await app.service('session-mcp-servers').create(
                {
                  session_id: session.session_id,
                  mcp_server_id: mcpServerId,
                },
                baseServiceParams
              );
            }
            console.log(`✅ Attached ${mcpServerIds.length} MCP servers`);
          }

          // Execute initial prompt if provided
          let promptResponse = null;
          if (args.initialPrompt) {
            console.log(`🚀 Executing initial prompt`);
            promptResponse = await app.service('/sessions/:id/prompt').create(
              {
                prompt: args.initialPrompt,
                permissionMode: permissionMode,
                stream: true,
              },
              {
                ...baseServiceParams,
                route: { id: session.session_id },
              }
            );
          }

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session,
                    taskId: promptResponse?.taskId,
                    note: args.initialPrompt
                      ? 'Session created and initial prompt execution started.'
                      : 'Session created successfully.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (name === 'agor_sessions_update') {
          // Update session metadata
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

          // Validate at least one field is provided
          if (!args.title && !args.description && !args.status) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: at least one field (title, description, status) must be provided',
              },
            });
          }

          console.log(`📝 MCP updating session ${args.sessionId.substring(0, 8)}`);

          // Build update object
          const updates: Record<string, unknown> = {};
          if (args.title !== undefined) updates.title = args.title;
          if (args.description !== undefined) updates.description = args.description;
          if (args.status !== undefined) updates.status = args.status;

          // Update session
          const session = await app
            .service('sessions')
            .patch(args.sessionId, updates, baseServiceParams);
          console.log(`✅ Session updated`);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    session,
                    note: 'Session updated successfully.',
                  },
                  null,
                  2
                ),
              },
            ],
          };

          // Repository tools
        } else if (name === 'agor_repos_list') {
          const query: Record<string, unknown> = {};
          if (args?.slug) query.slug = args.slug;
          if (args?.limit) query.$limit = args.limit;

          const repos = await app.service('repos').find({ query, ...baseServiceParams });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repos, null, 2),
              },
            ],
          };
        } else if (name === 'agor_repos_get') {
          if (!args?.repoId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: repoId is required',
              },
            });
          }

          const repo = await app.service('repos').get(args.repoId, baseServiceParams);
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repo, null, 2),
              },
            ],
          };
        } else if (name === 'agor_repos_create_remote') {
          const url = coerceString(args?.url);
          if (!url) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: url is required',
              },
            });
          }

          // Validate git URL format
          if (!isValidGitUrl(url)) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: url must be a valid git URL (https:// or git@)',
              },
            });
          }

          // Derive slug from URL if not provided
          let slug = coerceString(args?.slug);
          if (!slug) {
            try {
              slug = extractSlugFromUrl(url);
            } catch (_error) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: `Could not derive slug from URL. Please provide a slug explicitly.`,
                },
              });
            }
          }

          // Validate slug format
          if (!isValidSlug(slug)) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: slug must be in org/name format',
              },
            });
          }

          const name = coerceString(args?.name);

          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          const result = await reposService.cloneRepository({ url, slug, name }, baseServiceParams);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else if (name === 'agor_repos_create_local') {
          const path = coerceString(args?.path);
          if (!path) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: path is required',
              },
            });
          }

          const slug = coerceString(args?.slug);

          const reposService = app.service('repos') as unknown as ReposServiceImpl;
          const repo = await reposService.addLocalRepository({ path, slug }, baseServiceParams);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(repo, null, 2),
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

          // Include session activity in MCP worktree get calls
          // Pass enrichment flags at params root level to bypass Feathers query filtering
          const worktree = await app.service('worktrees').get(args.worktreeId, {
            ...baseServiceParams,
            _include_sessions: true,
            _last_message_truncation_length: 500,
            // biome-ignore lint/suspicious/noExplicitAny: Custom params bypass Feathers type system
          } as any);
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

          const refType = (coerceString(args?.refType) as 'branch' | 'tag') || 'branch';
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

          // boardId is now required
          const boardId = coerceString(args?.boardId);
          if (!boardId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: boardId is required',
              },
            });
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
              refType,
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
        } else if (name === 'agor_worktrees_update') {
          const requestedWorktreeId = coerceString(args?.worktreeId);
          let resolvedWorktreeId = requestedWorktreeId;

          if (!resolvedWorktreeId) {
            const currentSession = await app.service('sessions').get(context.sessionId);
            const sessionWorktreeId = currentSession.worktree_id;

            if (!sessionWorktreeId) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message:
                    'Invalid params: worktreeId is required when current session is not bound to a worktree',
                },
              });
            }

            resolvedWorktreeId = sessionWorktreeId;
          }

          if (!resolvedWorktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId could not be resolved',
              },
            });
          }

          const worktreeId = resolvedWorktreeId;

          let fieldsProvided = 0;
          const updates: Record<string, unknown> = {};

          try {
            if (args && Object.hasOwn(args, 'issueUrl')) {
              fieldsProvided++;
              const rawIssueUrl = args.issueUrl;
              if (rawIssueUrl === null) {
                updates.issue_url = null;
              } else {
                const normalizedIssueUrl = normalizeOptionalHttpUrl(rawIssueUrl, 'issueUrl');
                updates.issue_url = normalizedIssueUrl ?? null;
              }
            }

            if (args && Object.hasOwn(args, 'pullRequestUrl')) {
              fieldsProvided++;
              const rawPullRequestUrl = args.pullRequestUrl;
              if (rawPullRequestUrl === null) {
                updates.pull_request_url = null;
              } else {
                const normalizedPullRequestUrl = normalizeOptionalHttpUrl(
                  rawPullRequestUrl,
                  'pullRequestUrl'
                );
                updates.pull_request_url = normalizedPullRequestUrl ?? null;
              }
            }
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

          if (args && Object.hasOwn(args, 'notes')) {
            fieldsProvided++;
            const rawNotes = args.notes;
            if (rawNotes === null) {
              updates.notes = null;
            } else if (typeof rawNotes === 'string') {
              const trimmedNotes = rawNotes.trim();
              updates.notes = trimmedNotes.length > 0 ? trimmedNotes : null;
            } else {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: notes must be a string or null',
                },
              });
            }
          }

          if (args && Object.hasOwn(args, 'boardId')) {
            fieldsProvided++;
            const rawBoardId = args.boardId;
            if (rawBoardId === null) {
              updates.board_id = null;
            } else {
              const boardId = coerceString(rawBoardId);
              if (!boardId) {
                return res.status(400).json({
                  jsonrpc: '2.0',
                  id: mcpRequest.id,
                  error: {
                    code: -32602,
                    message: 'Invalid params: boardId must be a non-empty string or null',
                  },
                });
              }
              updates.board_id = boardId;
            }
          }

          if (args && Object.hasOwn(args, 'customContext')) {
            fieldsProvided++;
            const rawCustomContext = args.customContext;
            if (rawCustomContext === null) {
              updates.custom_context = null;
            } else if (
              rawCustomContext &&
              typeof rawCustomContext === 'object' &&
              !Array.isArray(rawCustomContext)
            ) {
              updates.custom_context = rawCustomContext;
            } else {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Invalid params: customContext must be an object or null',
                },
              });
            }
          }

          if (fieldsProvided === 0) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: provide at least one field to update (issueUrl, pullRequestUrl, notes, boardId, customContext)',
              },
            });
          }

          console.log(`📝 MCP updating worktree ${worktreeId.substring(0, 8)}`);
          const worktree = await app
            .service('worktrees')
            .patch(worktreeId, updates, baseServiceParams);
          console.log(`✅ Worktree updated`);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    worktree,
                    note: 'Worktree metadata updated successfully.',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (name === 'agor_worktrees_set_zone') {
          // Pin worktree to zone and optionally trigger zone prompt
          const worktreeId = coerceString(args?.worktreeId);
          const zoneId = coerceString(args?.zoneId);
          const targetSessionId = coerceString(args?.targetSessionId);
          const triggerTemplate = args?.triggerTemplate === true;

          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          if (!zoneId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: zoneId is required',
              },
            });
          }

          console.log(`📍 MCP pinning worktree ${worktreeId.substring(0, 8)} to zone ${zoneId}`);

          try {
            // Get worktree to find its board
            const worktree = await app.service('worktrees').get(worktreeId, baseServiceParams);

            if (!worktree.board_id) {
              return res.status(400).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: 'Worktree must be on a board before it can be pinned to a zone',
                },
              });
            }

            // Get board to find zone definition
            const board = await app.service('boards').get(worktree.board_id, baseServiceParams);

            const zone = board.objects?.[zoneId];
            if (!zone || zone.type !== 'zone') {
              return res.status(404).json({
                jsonrpc: '2.0',
                id: mcpRequest.id,
                error: {
                  code: -32602,
                  message: `Zone ${zoneId} not found on board ${worktree.board_id}`,
                },
              });
            }

            // Calculate position RELATIVE to zone (not absolute canvas coordinates)
            // The UI expects relative positions and adds zone.x/zone.y when rendering
            // (see apps/agor-ui/src/components/SessionCanvas/SessionCanvas.tsx:480-481)
            const WORKTREE_CARD_WIDTH = 500;
            const WORKTREE_CARD_HEIGHT = 200;

            // Add jitter to prevent worktree cards from stacking exactly on top of each other
            // Use adaptive padding to keep cards away from zone edges when possible
            const DESIRED_PADDING = 80; // pixels from zone edges (best effort)

            // Calculate adaptive padding that respects zone constraints
            // For small zones, reduce padding to ensure cards fit within bounds
            const maxPaddingX = Math.max(0, (zone.width - WORKTREE_CARD_WIDTH) / 2);
            const maxPaddingY = Math.max(0, (zone.height - WORKTREE_CARD_HEIGHT) / 2);
            const paddingX = Math.min(DESIRED_PADDING, maxPaddingX);
            const paddingY = Math.min(DESIRED_PADDING, maxPaddingY);

            // Calculate jitter range (clamped to >= 0 for small zones)
            const jitterRangeX = Math.max(0, zone.width - WORKTREE_CARD_WIDTH - 2 * paddingX);
            const jitterRangeY = Math.max(0, zone.height - WORKTREE_CARD_HEIGHT - 2 * paddingY);

            // Generate random position within valid area
            // For zones too small for jitter, cards will be centered (jitterRange = 0)
            const relativeX = paddingX + Math.random() * jitterRangeX;
            const relativeY = paddingY + Math.random() * jitterRangeY;

            // Log warning if zone is smaller than card (card will overflow)
            if (zone.width < WORKTREE_CARD_WIDTH || zone.height < WORKTREE_CARD_HEIGHT) {
              console.warn(
                `⚠️  Zone ${zoneId} is smaller than worktree card (${zone.width}x${zone.height} < ${WORKTREE_CARD_WIDTH}x${WORKTREE_CARD_HEIGHT}), card may overflow zone bounds`
              );
            }

            // Find or create board object for this worktree
            const boardObjectsService = app.service('board-objects') as unknown as {
              findByWorktreeId: (
                worktreeId: import('@agor/core/types').WorktreeID,
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
              await boardObjectsService.findByWorktreeId(
                worktreeId as import('@agor/core/types').WorktreeID,
                baseServiceParams
              );

            if (!boardObject) {
              // Create new board object
              boardObject = await boardObjectsService.create(
                {
                  board_id: worktree.board_id as import('@agor/core/types').BoardID,
                  worktree_id: worktreeId as import('@agor/core/types').WorktreeID,
                  position: { x: relativeX, y: relativeY },
                  zone_id: zoneId,
                },
                baseServiceParams
              );
            } else {
              // Update existing board object with zone and center position
              // Use patch() to update both position and zone_id atomically with single WebSocket event
              boardObject = await boardObjectsService.patch(
                boardObject.object_id,
                {
                  position: { x: relativeX, y: relativeY },
                  zone_id: zoneId,
                },
                baseServiceParams
              );
            }

            console.log(
              `✅ Worktree pinned to zone at relative position (${relativeX}, ${relativeY})`
            );

            // Determine whether to fire zone trigger
            // Priority:
            // 1. Explicit triggerTemplate=true + targetSessionId → send to existing session
            // 2. Zone has always_new trigger → auto-create session and execute
            // 3. triggerTemplate=true but missing targetSessionId or template → return error note
            // 4. Zone has show_picker trigger → return trigger info (agent picks action)
            // 5. No trigger → just pin
            let promptResult: { taskId?: string; sessionId?: string; note: string } | undefined;

            const hasZoneTrigger =
              zone.trigger?.template && zone.trigger.template.trim().length > 0;
            const isAlwaysNew = hasZoneTrigger && zone.trigger!.behavior === 'always_new';

            if (triggerTemplate && targetSessionId && hasZoneTrigger) {
              // Case 1: Explicit trigger to an existing session (original behavior)
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
                const promptResponse = await app.service('/sessions/:id/prompt').create(
                  {
                    prompt: renderedPrompt,
                    stream: true,
                  },
                  {
                    ...baseServiceParams,
                    route: { id: targetSessionId },
                  }
                );

                promptResult = {
                  taskId: promptResponse.taskId,
                  sessionId: targetSessionId,
                  note: 'Zone trigger prompt sent to target session',
                };
                console.log(
                  `✅ Zone trigger executed: task ${promptResponse.taskId.substring(0, 8)}`
                );
              } else {
                promptResult = {
                  note: 'Zone trigger template rendered to empty string (check template syntax)',
                };
                console.warn('⚠️  Zone trigger template rendered to empty string');
              }
            } else if (isAlwaysNew) {
              // Case 2: always_new — auto-create session and execute trigger
              // Fires both when no flags are set AND when triggerTemplate=true without targetSessionId
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
                // Determine agent from trigger config, validate against known values
                const validAgents: AgenticToolName[] = [
                  'claude-code',
                  'codex',
                  'gemini',
                  'opencode',
                ];
                const rawAgent = zone.trigger!.agent;
                const agenticTool: AgenticToolName =
                  rawAgent && validAgents.includes(rawAgent) ? rawAgent : 'claude-code';

                // Fetch user data for session creation context
                const user = await app.service('users').get(context.userId, baseServiceParams);

                // Get current git state
                const { getGitState, getCurrentBranch } = await import('@agor/core/git');
                const currentSha = await getGitState(worktree.path);
                const currentRef = await getCurrentBranch(worktree.path);

                // Resolve permission mode from user defaults
                const { getDefaultPermissionMode } = await import('@agor/core/types');
                const { mapPermissionMode } = await import(
                  '@agor/core/utils/permission-mode-mapper'
                );
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

                // Build model config from user defaults (only if a model is specified)
                // Other fields like thinkingMode require a model context to be meaningful
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

                // Resolve MCP server IDs from user defaults
                const mcpServerIds = userToolDefaults?.mcpServerIds || [];

                // Create new session
                const sessionData: Record<string, unknown> = {
                  worktree_id: worktreeId,
                  agentic_tool: agenticTool,
                  status: 'idle',
                  description: `Session from zone "${zone.label}"`,
                  created_by: context.userId,
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

                const newSession = await app
                  .service('sessions')
                  .create(sessionData, baseServiceParams);
                console.log(
                  `✅ Auto-created session ${newSession.session_id.substring(0, 8)} (${agenticTool})`
                );

                // Attach MCP servers from user defaults
                if (mcpServerIds.length > 0) {
                  for (const mcpServerId of mcpServerIds) {
                    await app.service('session-mcp-servers').create(
                      {
                        session_id: newSession.session_id,
                        mcp_server_id: mcpServerId,
                      },
                      baseServiceParams
                    );
                  }
                  console.log(`✅ Attached ${mcpServerIds.length} MCP servers`);
                }

                // Send rendered prompt to new session
                const promptResponse = await app.service('/sessions/:id/prompt').create(
                  {
                    prompt: renderedPrompt,
                    stream: true,
                  },
                  {
                    ...baseServiceParams,
                    route: { id: newSession.session_id },
                  }
                );

                promptResult = {
                  taskId: promptResponse.taskId,
                  sessionId: newSession.session_id,
                  note: `always_new trigger: created session ${newSession.session_id.substring(0, 8)} (${agenticTool}) and sent prompt`,
                };
                console.log(
                  `✅ Zone trigger executed: task ${promptResponse.taskId.substring(0, 8)}`
                );
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

            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree_id: worktree.worktree_id,
                      zone_id: zoneId,
                      position: { x: relativeX, y: relativeY },
                      board_object_id: boardObject.object_id,
                      ...(promptResult ? { trigger: promptResult } : {}),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            console.error('❌ Failed to set worktree zone:', error);
            return res.status(500).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32603,
                message: `Failed to set worktree zone: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
          }

          // Environment tools
        } else if (name === 'agor_environment_start') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          try {
            const worktree = await worktreesService.startEnvironment(
              worktreeId as import('@agor/core/types').WorktreeID,
              baseServiceParams
            );
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_environment_stop') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          try {
            const worktree = await worktreesService.stopEnvironment(
              worktreeId as import('@agor/core/types').WorktreeID,
              baseServiceParams
            );
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_environment_health') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          const worktree = await worktreesService.checkHealth(
            worktreeId as import('@agor/core/types').WorktreeID,
            baseServiceParams
          );
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: worktree.environment_instance?.status || 'unknown',
                    lastHealthCheck: worktree.environment_instance?.last_health_check,
                    worktree,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else if (name === 'agor_environment_logs') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          const logsResult = await worktreesService.getLogs(
            worktreeId as import('@agor/core/types').WorktreeID,
            baseServiceParams
          );
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(logsResult, null, 2),
              },
            ],
          };
        } else if (name === 'agor_environment_open_app') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          const worktree = await worktreesService.get(
            worktreeId as import('@agor/core/types').WorktreeID,
            baseServiceParams
          );

          const appUrl = worktree.environment_instance?.access_urls?.[0]?.url;
          if (!appUrl) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: 'No app URL configured for this worktree',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } else {
            // Note: We can't actually open the browser from server-side, but we can return the URL
            // The agent can use this URL to inform the user or take other actions
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      url: appUrl,
                      message: `App URL: ${appUrl}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        } else if (name === 'agor_environment_nuke') {
          const worktreeId = coerceString(args?.worktreeId);
          if (!worktreeId) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: worktreeId is required',
              },
            });
          }

          const worktreesService = app.service(
            'worktrees'
          ) as unknown as import('../declarations').WorktreesServiceImpl;
          try {
            const worktree = await worktreesService.nukeEnvironment(
              worktreeId as import('@agor/core/types').WorktreeID,
              baseServiceParams
            );
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: true,
                      worktree,
                      message: 'Environment nuked successfully - all data and volumes destroyed',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          } catch (error) {
            mcpResponse = {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      success: false,
                      error: error instanceof Error ? error.message : 'Unknown error',
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }

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
        } else if (name === 'agor_boards_update') {
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

          console.log(`📝 MCP updating board ${args.boardId.substring(0, 8)}`);

          const boardsService = app.service(
            'boards'
          ) as unknown as import('../declarations').BoardsServiceImpl;

          // Build metadata updates
          const metadataUpdates: Record<string, unknown> = {};
          if (args.name !== undefined) metadataUpdates.name = args.name;
          if (args.description !== undefined) metadataUpdates.description = args.description;
          if (args.icon !== undefined) metadataUpdates.icon = args.icon;
          if (args.color !== undefined) metadataUpdates.color = args.color;
          if (args.backgroundColor !== undefined)
            metadataUpdates.background_color = args.backgroundColor;
          if (args.slug !== undefined) metadataUpdates.slug = args.slug;
          if (args.customContext !== undefined) metadataUpdates.custom_context = args.customContext;

          // Update board metadata if any provided
          if (Object.keys(metadataUpdates).length > 0) {
            await app.service('boards').patch(args.boardId, metadataUpdates, baseServiceParams);
            console.log(`✅ Board metadata updated`);
          }

          // Handle object upserts (zones, text, markdown)
          if (
            args.upsertObjects &&
            typeof args.upsertObjects === 'object' &&
            !Array.isArray(args.upsertObjects)
          ) {
            // Note: declarations.ts says unknown[] but the actual implementation expects Record<string, BoardObject>
            const updatedBoard = await boardsService.batchUpsertBoardObjects(
              args.boardId,
              args.upsertObjects as unknown as unknown[],
              baseServiceParams
            );
            console.log(`✅ Upserted ${Object.keys(args.upsertObjects).length} board object(s)`);

            // Emit WebSocket event for real-time updates
            app.service('boards').emit('patched', updatedBoard);
          }

          // Handle object removals
          if (args.removeObjects && Array.isArray(args.removeObjects)) {
            let finalBoard: Board | undefined;
            for (const objectId of args.removeObjects) {
              finalBoard = await boardsService.removeBoardObject(
                args.boardId,
                objectId,
                baseServiceParams
              );
            }
            console.log(`✅ Removed ${args.removeObjects.length} board object(s)`);

            // Emit WebSocket event for real-time updates (use final board state after all removals)
            if (finalBoard) {
              app.service('boards').emit('patched', finalBoard);
            }
          }

          // Get updated board
          const board = await app.service('boards').get(args.boardId, baseServiceParams);

          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    board,
                    note: 'Board updated successfully.',
                  },
                  null,
                  2
                ),
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
        } else if (name === 'agor_users_update') {
          // Update any user (admin operation)
          if (!args?.userId || typeof args.userId !== 'string') {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message: 'Invalid params: userId is required and must be a string',
              },
            });
          }

          // Build update object - only include fields that are provided
          const updateData: Record<string, unknown> = {};
          if (args?.email !== undefined) updateData.email = args.email;
          if (args?.name !== undefined) updateData.name = args.name;
          if (args?.password !== undefined) updateData.password = args.password;
          if (args?.role !== undefined) updateData.role = args.role;
          if (args?.unix_username !== undefined) updateData.unix_username = args.unix_username;
          if (args?.must_change_password !== undefined)
            updateData.must_change_password = args.must_change_password;
          if (args?.emoji !== undefined) updateData.emoji = args.emoji;
          if (args?.avatar !== undefined) updateData.avatar = args.avatar;
          if (args?.preferences !== undefined) updateData.preferences = args.preferences;

          if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id,
              error: {
                code: -32602,
                message:
                  'Invalid params: at least one field must be provided to update (email, name, password, role, unix_username, must_change_password, emoji, avatar, preferences)',
              },
            });
          }

          console.log(`📝 MCP updating user ${args.userId.substring(0, 8)}`);
          const updatedUser = await app.service('users').patch(args.userId, updateData);
          console.log(`✅ User updated`);

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
          if (args?.unix_username !== undefined) createData.unix_username = args.unix_username;
          if (args?.must_change_password !== undefined)
            createData.must_change_password = args.must_change_password;
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
        } else if (name === 'agor_analytics_leaderboard') {
          // Get usage analytics leaderboard
          const query: Record<string, unknown> = {};

          // Add filters
          if (args?.userId) query.userId = args.userId;
          if (args?.worktreeId) query.worktreeId = args.worktreeId;
          if (args?.repoId) query.repoId = args.repoId;
          if (args?.startDate) query.startDate = args.startDate;
          if (args?.endDate) query.endDate = args.endDate;

          // Add groupBy
          if (args?.groupBy) query.groupBy = args.groupBy;

          // Add sorting
          if (args?.sortBy) query.sortBy = args.sortBy;
          if (args?.sortOrder) query.sortOrder = args.sortOrder;

          // Add pagination
          if (args?.limit) query.limit = args.limit;
          if (args?.offset) query.offset = args.offset;

          const leaderboard = await app.service('leaderboard').find({ query });
          mcpResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(leaderboard, null, 2),
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
