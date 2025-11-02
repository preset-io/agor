/**
 * Query Builder for Claude Agent SDK
 *
 * Handles query setup, configuration, and session initialization.
 * Manages MCP server configuration, resume/fork/spawn logic, and working directory validation.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk/sdk';
import { resolveApiKey } from '../../config';
import type { Database } from '../../db/client';
import type { MCPServerRepository } from '../../db/repositories/mcp-servers';
import type { MessagesRepository } from '../../db/repositories/messages';
import type { RepoRepository } from '../../db/repositories/repos';
import type { SessionMCPServerRepository } from '../../db/repositories/session-mcp-servers';
import type { SessionRepository } from '../../db/repositories/sessions';
import type { WorktreeRepository } from '../../db/repositories/worktrees';
import { validateDirectory } from '../../lib/validation';
import type { PermissionService } from '../../permissions/permission-service';
import type { MCPServersConfig, SessionID, TaskID } from '../../types';
import type { MessagesService, SessionsService, TasksService } from './claude-tool';
import { DEFAULT_CLAUDE_MODEL } from './models';
import { createPreToolUseHook } from './permissions/permission-hooks';
import { appendSessionContextToCLAUDEmd } from './session-context';
import { detectThinkingLevel, resolveThinkingBudget } from './thinking-detector';

/**
 * Get path to Claude Code executable
 * Uses `which claude` to find it in PATH
 */
function getClaudeCodePath(): string {
  try {
    const path = execSync('which claude', { encoding: 'utf-8' }).trim();
    if (path) return path;
  } catch {
    // which failed, try common paths
  }

  // Fallback to common installation paths
  const commonPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.nvm/versions/node/v20.19.4/bin/claude`,
  ];

  for (const path of commonPaths) {
    try {
      execSync(`test -x "${path}"`, { encoding: 'utf-8' });
      return path;
    } catch {}
  }

  throw new Error(
    'Claude Code executable not found. Install with: npm install -g @anthropic-ai/claude-code'
  );
}

/**
 * Log prompt start with context
 */
function logPromptStart(
  sessionId: SessionID,
  _prompt: string,
  _cwd: string,
  agentSessionId?: string
) {
  console.log(`🤖 Prompting Claude for session ${sessionId.substring(0, 8)}...`);
  if (agentSessionId) {
    console.log(`   Resuming session: ${agentSessionId}`);
  }
}

export interface QuerySetupDeps {
  sessionsRepo: SessionRepository;
  reposRepo?: RepoRepository;
  messagesRepo?: MessagesRepository;
  apiKey?: string;
  sessionMCPRepo?: SessionMCPServerRepository;
  mcpServerRepo?: MCPServerRepository;
  permissionService?: PermissionService;
  tasksService?: TasksService;
  sessionsService?: SessionsService;
  messagesService?: MessagesService;
  worktreesRepo?: WorktreeRepository;
  permissionLocks: Map<SessionID, Promise<void>>;
  mcpEnabled?: boolean;
  db?: Database;
}

/**
 * Setup and configure query for Claude Agent SDK
 * Handles session loading, CWD resolution, MCP configuration, and resume/fork/spawn logic
 */
export async function setupQuery(
  sessionId: SessionID,
  prompt: string,
  deps: QuerySetupDeps,
  options: {
    taskId?: TaskID;
    permissionMode?: PermissionMode;
    resume?: boolean;
  } = {}
): Promise<{
  // biome-ignore lint/suspicious/noExplicitAny: SDK Message types include user, assistant, stream_event, result, etc.
  query: AsyncGenerator<any, any, unknown>;
  resolvedModel: string;
  getStderr: () => string;
}> {
  const { taskId, permissionMode, resume = true } = options;

  const session = await deps.sessionsRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Determine model to use (session config or default)
  const modelConfig = session.model_config;
  const model = modelConfig?.model || DEFAULT_CLAUDE_MODEL;

  // Determine CWD from worktree (if session has one)
  let cwd = process.cwd();
  if (session.worktree_id && deps.worktreesRepo) {
    try {
      const worktree = await deps.worktreesRepo.findById(session.worktree_id);
      if (worktree) {
        cwd = worktree.path;
        console.log(`✅ Using worktree path as cwd: ${cwd}`);
      } else {
        console.warn(
          `⚠️  Session ${sessionId} references non-existent worktree ${session.worktree_id}, using process.cwd(): ${cwd}`
        );
      }
    } catch (error) {
      console.error(`❌ Failed to fetch worktree ${session.worktree_id}:`, error);
      console.warn(`   Falling back to process.cwd(): ${cwd}`);
    }
  } else {
    console.warn(`⚠️  Session ${sessionId} has no worktree_id, using process.cwd(): ${cwd}`);
  }

  logPromptStart(sessionId, prompt, cwd, resume ? session.sdk_session_id : undefined);

  // Validate CWD exists before calling SDK
  try {
    await validateDirectory(cwd, 'Working directory');
    // List directory contents for debugging (helps diagnose bare repo issues)
    try {
      const files = await fs.readdir(cwd);
      const fileCount = files.length;
      const hasGit = files.includes('.git');
      const hasClaude = files.includes('.claude');
      const hasCLAUDEmd = files.includes('CLAUDE.md');
      console.log(
        `✅ Working directory validated: ${cwd} (${fileCount} files/dirs${hasGit ? ', has .git' : ', NO .git!'}${hasClaude ? ', has .claude/' : ''}${hasCLAUDEmd ? ', has CLAUDE.md' : ''})`
      );
      if (fileCount === 0) {
        console.warn(`⚠️  Working directory is EMPTY - worktree may be from bare repo!`);
      } else if (!hasGit) {
        console.warn(`⚠️  Working directory has no .git - not a valid worktree!`);
      }
      if (!hasCLAUDEmd && !hasClaude) {
        console.warn(`⚠️  No CLAUDE.md or .claude/ directory found - SDK may not load properly`);
      }
    } catch (listError) {
      console.warn(`⚠️  Could not list directory contents:`, listError);
    }

    // Append Agor session context to CLAUDE.md
    // This makes the agent aware of its session ID
    await appendSessionContextToCLAUDEmd(cwd, sessionId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Working directory validation failed: ${errorMessage}`);
    throw new Error(
      `${errorMessage}${
        session.worktree_id
          ? ` Session references worktree ${session.worktree_id} which may not be initialized.`
          : ''
      }`
    );
  }

  // Get Claude Code path
  const claudeCodePath = getClaudeCodePath();

  // Buffer to capture stderr for better error messages
  let stderrBuffer = '';

  const queryOptions: Record<string, unknown> = {
    cwd,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project'], // Load user + project permissions, auto-loads CLAUDE.md
    model, // Use configured model or default
    pathToClaudeCodeExecutable: claudeCodePath,
    // Allow access to common directories outside CWD (e.g., /tmp)
    additionalDirectories: ['/tmp', '/var/tmp'],
    // Enable token-level streaming (yields partial messages as tokens arrive)
    includePartialMessages: true,
    // Enable debug logging to see what's happening
    debug: true,
    // Capture stderr to get actual error messages (not just "exit code 1")
    stderr: (data: string) => {
      stderrBuffer += data;
      // Log in real-time for debugging
      if (data.trim()) {
        console.error(`[Claude stderr] ${data.trim()}`);
      }
    },
  };

  // Add permissionMode if provided
  // For Claude Code sessions, the UI should pass Claude SDK permission modes directly:
  // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  // No mapping needed - UI is responsible for showing correct options per agent type
  if (permissionMode) {
    // SECURITY: bypassPermissions cannot be used with root/sudo
    // Claude Code blocks this for security reasons
    const isRoot = process.getuid?.() === 0;

    if (isRoot && permissionMode === 'bypassPermissions') {
      console.warn(
        `⚠️  Running as root - bypassPermissions not allowed. Falling back to 'default' mode.`
      );
      console.warn(`   This is a security restriction from Claude Code SDK.`);
      queryOptions.permissionMode = 'default';
    } else {
      queryOptions.permissionMode = permissionMode;
    }

    console.log(`🔐 Permission mode: ${queryOptions.permissionMode}`);
  }

  // Add session-level allowed tools from our database
  // NOTE: Always add allowedTools (even for bypassPermissions workaround)
  const sessionAllowedTools = session.permission_config?.allowedTools || [];
  if (sessionAllowedTools.length > 0) {
    queryOptions.allowedTools = sessionAllowedTools;
  }

  // Configure thinking budget based on mode and prompt keywords
  // Matches Claude Code CLI behavior: auto-detect keywords or use manual setting
  const thinkingBudget = resolveThinkingBudget(prompt, {
    thinkingMode: session.model_config?.thinkingMode,
    manualThinkingTokens: session.model_config?.manualThinkingTokens,
  });

  if (thinkingBudget !== null && thinkingBudget > 0) {
    queryOptions.maxThinkingTokens = thinkingBudget;
    console.log(`🧠 Thinking budget: ${thinkingBudget.toLocaleString()} tokens`);

    // Log detected keywords in auto mode
    if (session.model_config?.thinkingMode === 'auto' || !session.model_config?.thinkingMode) {
      const detected = detectThinkingLevel(prompt);
      if (detected.level !== 'none') {
        console.log(
          `   Auto-detected level: ${detected.level} (phrases: ${detected.detectedPhrases.join(', ')})`
        );
      }
    }
  } else {
    console.log(`🧠 Thinking disabled (mode: ${session.model_config?.thinkingMode || 'auto'})`);
  }

  // Add PreToolUse hook if permission service is available and taskId provided
  // This enables Agor's custom permission UI (WebSocket-based) instead of CLI prompts
  // IMPORTANT: Only skip hook for bypassPermissions (which never asks for permissions)
  // Note: effectivePermissionMode is the ACTUAL mode after root fallback (queryOptions.permissionMode)
  const effectivePermissionMode = queryOptions.permissionMode;
  if (deps.permissionService && taskId && effectivePermissionMode !== 'bypassPermissions') {
    queryOptions.hooks = {
      PreToolUse: [
        {
          hooks: [
            createPreToolUseHook(sessionId, taskId, {
              permissionService: deps.permissionService,
              tasksService: deps.tasksService!,
              sessionsRepo: deps.sessionsRepo,
              reposRepo: deps.reposRepo,
              messagesRepo: deps.messagesRepo!,
              messagesService: deps.messagesService,
              sessionsService: deps.sessionsService,
              worktreesRepo: deps.worktreesRepo,
              permissionLocks: deps.permissionLocks,
            }),
          ],
        },
      ],
    };
    console.log(`🪝 PreToolUse hook added (permission mode: ${effectivePermissionMode})`);
  }

  // Add optional apiKey if provided
  // NOTE: Don't require API key - user may have used `claude login` (OAuth)
  // Precedence: per-user key > config.yaml (UI) > process.env
  const apiKey = await resolveApiKey('ANTHROPIC_API_KEY', {
    userId: session.created_by as import('../../types').UserID | undefined,
    db: deps.db,
  });
  if (apiKey) {
    queryOptions.apiKey = apiKey;
  }

  // Handle resume, fork, and spawn cases
  if (resume) {
    // CASE 1: Fork/Spawn on first prompt (has genealogy, no sdk_session_id yet)
    const parentSessionId =
      session.genealogy?.forked_from_session_id || session.genealogy?.parent_session_id;

    if (parentSessionId && !session.sdk_session_id && deps.sessionsRepo) {
      // This is a fork/spawn - load parent's sdk_session_id
      const parentSession = await deps.sessionsRepo.findById(parentSessionId);

      if (parentSession?.sdk_session_id) {
        queryOptions.resume = parentSession.sdk_session_id;
        queryOptions.forkSession = true; // SDK will create new session ID from parent's history
        console.log(
          `🍴 Forking from parent session: ${parentSession.sdk_session_id.substring(0, 8)}`
        );
        console.log(`   SDK will return new session ID for this fork`);
      } else {
        console.warn(
          `⚠️  Parent session ${parentSessionId.substring(0, 8)} has no sdk_session_id - starting fresh`
        );
      }
    }
    // CASE 2: Normal resume (session has its own sdk_session_id)
    else if (session?.sdk_session_id) {
      // Check if session might be stale (prevents exit code 1 errors)
      const hoursSinceUpdate = session.last_updated
        ? (Date.now() - new Date(session.last_updated).getTime()) / (1000 * 60 * 60)
        : 999;

      const isLikelyStale =
        hoursSinceUpdate > 24 || // Session older than 24 hours
        !session.worktree_id; // No worktree = can't resume properly

      if (isLikelyStale) {
        console.warn(
          `⚠️  Resume session ${session.sdk_session_id.substring(0, 8)} appears stale (${Math.round(hoursSinceUpdate)}h old) - starting fresh`
        );

        // Clear stale session ID to prevent exit code 1
        if (deps.sessionsRepo) {
          await deps.sessionsRepo.update(sessionId, { sdk_session_id: undefined });
        }
        // Don't set queryOptions.resume - start fresh
      } else {
        queryOptions.resume = session.sdk_session_id;
        console.log(`   Resuming SDK session: ${session.sdk_session_id.substring(0, 8)}`);
      }
    }
    // CASE 3: Fresh session (no genealogy, no sdk_session_id)
    // -> queryOptions.resume not set, SDK will start fresh and return new session ID
  }

  // Configure Agor MCP server (self-access to daemon) - only if MCP is enabled
  if (deps.mcpEnabled !== false) {
    const mcpToken = session.mcp_token;
    console.log(`🔍 [MCP DEBUG] Checking for MCP token in session ${sessionId.substring(0, 8)}`);
    console.log(
      `   session.mcp_token: ${mcpToken ? `${mcpToken.substring(0, 16)}...` : 'NOT FOUND'}`
    );

    if (mcpToken) {
      // Get daemon URL from config (default: http://localhost:3030)
      const daemonUrl = process.env.VITE_DAEMON_URL || 'http://localhost:3030';

      console.log(`🔌 Configuring Agor MCP server (self-access to daemon)`);
      const mcpConfig = {
        agor: {
          type: 'http' as const,
          url: `${daemonUrl}/mcp?sessionToken=${mcpToken}`,
        },
      };
      queryOptions.mcpServers = mcpConfig;
      console.log(`   MCP server config:`, JSON.stringify(mcpConfig, null, 2));
      console.log(`   Full URL: ${daemonUrl}/mcp?sessionToken=${mcpToken.substring(0, 16)}...`);
    } else {
      console.warn(`⚠️  No MCP token found for session ${sessionId.substring(0, 8)}`);
      console.warn(`   Session will not have access to Agor MCP tools`);
    }
  } else {
    console.log(`🔒 Agor MCP server disabled - skipping MCP configuration`);
  }

  // Fetch and configure MCP servers for this session (hierarchical scoping)
  if (deps.sessionMCPRepo && deps.mcpServerRepo) {
    try {
      const allServers: Array<{
        // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from multiple sources
        server: any;
        source: string;
      }> = [];

      // 1. Global servers (always included)
      console.log('🔌 Fetching MCP servers with hierarchical scoping...');
      const globalServers = await deps.mcpServerRepo?.findAll({
        scope: 'global',
        enabled: true,
      });
      console.log(`   📍 Global scope: ${globalServers?.length ?? 0} server(s)`);
      for (const server of globalServers ?? []) {
        allServers.push({ server, source: 'global' });
      }

      // 2. Repo-scoped servers (if session has a worktree)
      // Get repo_id from the worktree
      let repoId: string | undefined;
      // Note: session is guaranteed non-null due to check at line 331-332
      // Using non-null assertions due to TypeScript's control flow analysis limitations with class properties
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const worktreeId = session!.worktree_id;
      if (worktreeId && deps.worktreesRepo) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const worktree = await deps.worktreesRepo!.findById(worktreeId);
        repoId = worktree?.repo_id;
      }
      if (repoId) {
        const repoServers = await deps.mcpServerRepo?.findAll({
          scope: 'repo',
          scopeId: repoId,
          enabled: true,
        });
        console.log(`   📍 Repo scope: ${repoServers?.length ?? 0} server(s)`);
        for (const server of repoServers ?? []) {
          allServers.push({ server, source: 'repo' });
        }
      }

      // 3. Team-scoped servers (if session has a team - future feature)
      // if (session.team_id) {
      //   const teamServers = await deps.mcpServerRepo.findAll({
      //     scope: 'team',
      //     scopeId: session.team_id,
      //     enabled: true,
      //   });
      //   console.log(`   📍 Team scope: ${teamServers.length} server(s)`);
      //   for (const server of teamServers) {
      //     allServers.push({ server, source: 'team' });
      //   }
      // }

      // 4. Session-specific servers (from join table)
      if (session && deps.sessionMCPRepo) {
        const sessionServers = await deps.sessionMCPRepo!.listServers(sessionId, true); // enabledOnly
        console.log(`   📍 Session scope: ${sessionServers!.length} server(s)`);
        for (const server of sessionServers!) {
          allServers.push({ server, source: 'session' });
        }
      } else {
        console.log('   📍 Session scope: 0 server(s)');
      }

      // 5. Deduplicate by server ID (later scopes override earlier ones)
      // This means: session > team > repo > global
      const serverMap = new Map<
        string,
        {
          // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from multiple sources
          server: any;
          source: string;
        }
      >();
      for (const item of allServers) {
        serverMap.set(item.server.mcp_server_id, item);
      }
      const uniqueServers = Array.from(serverMap.values());

      console.log(`   ✅ Total: ${uniqueServers.length} unique MCP server(s) after deduplication`);

      if (uniqueServers.length > 0) {
        // Convert to SDK format
        const mcpConfig: MCPServersConfig = {};
        const allowedTools: string[] = [];

        for (const { server, source } of uniqueServers) {
          console.log(`   - ${server.name} (${server.transport}) [${source}]`);

          // Build server config (convert 'transport' field to 'type' for Claude Code)
          const serverConfig: Record<string, unknown> = {
            type: server.transport,
            env: server.env,
          };

          // Add transport-specific fields
          if (server.transport === 'stdio') {
            serverConfig.command = server.command;
            serverConfig.args = server.args || [];
          } else {
            // http and sse both use url
            serverConfig.url = server.url;
          }

          mcpConfig[server.name] = serverConfig;

          // Add tools to allowlist
          if (server.tools) {
            for (const tool of server.tools) {
              allowedTools.push(tool.name);
            }
          }
        }

        // Merge with existing MCP servers (preserve Agor MCP server)
        queryOptions.mcpServers = {
          ...(queryOptions.mcpServers || {}),
          ...mcpConfig,
        };
        console.log(
          `   🔧 MCP config being passed to SDK:`,
          JSON.stringify(queryOptions.mcpServers, null, 2)
        );
        if (allowedTools.length > 0) {
          queryOptions.allowedTools = allowedTools;
          console.log(`   🔧 Allowing ${allowedTools.length} MCP tools`);
        }
      }
    } catch (error) {
      console.warn('⚠️  Failed to fetch MCP servers for session:', error);
      // Continue without MCP servers - non-fatal error
    }
  }

  console.log('📤 Calling query() with:');
  console.log(`   prompt: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  console.log(`   queryOptions keys: ${Object.keys(queryOptions).join(', ')}`);
  console.log(
    `   🔍 [MCP DEBUG] queryOptions.mcpServers:`,
    queryOptions.mcpServers ? JSON.stringify(queryOptions.mcpServers, null, 2) : 'NOT SET'
  );
  console.log(
    `   Full query call:`,
    JSON.stringify(
      {
        prompt,
        queryOptions,
      },
      null,
      2
    )
  );

  let result: AsyncGenerator<unknown>;
  try {
    result = query({
      prompt,
      // biome-ignore lint/suspicious/noExplicitAny: SDK Options type doesn't include all available fields
      options: queryOptions as any,
    });
    console.log(`✅ query() returned AsyncGenerator successfully`);
  } catch (syncError) {
    // This is rare - SDK usually returns AsyncGenerator that throws later
    console.error(`❌ CRITICAL: query() threw synchronous error (very unusual):`, syncError);
    console.error(`   Claude Code path: ${claudeCodePath}`);
    console.error(`   CWD: ${cwd}`);
    console.error(`   API key set: ${apiKey ? 'YES' : 'NO'}`);
    console.error(`   Resume session: ${queryOptions.resume || 'none (fresh session)'}`);
    throw syncError;
  }

  // Store stderr buffer getter for error reporting
  const getStderr = () => stderrBuffer;

  return { query: result, resolvedModel: model, getStderr };
}
