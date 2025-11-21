/**
 * Query Builder for Claude Agent SDK
 *
 * Handles query setup, configuration, and session initialization.
 * Manages MCP server configuration, resume/fork/spawn logic, and working directory validation.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { validateDirectory } from '@agor/core';
import { Claude } from '@agor/core/sdk';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';

const { query } = Claude;
type PermissionMode = Claude.PermissionMode;

import { getDaemonUrl, resolveUserEnvironment } from '../../config.js';
import type {
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { MCPServersConfig, SessionID, TaskID, UserID } from '../../types.js';
import type { MessagesService, SessionsService, TasksService } from './claude-tool.js';
import { DEFAULT_CLAUDE_MODEL } from './models.js';
import { createCanUseToolCallback } from './permissions/permission-hooks.js';
import { detectThinkingLevel, resolveThinkingBudget } from './thinking-detector.js';

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

  // Determine which user's context to use for environment variables and API keys
  // Priority: task creator (if task exists) > session owner (fallback)
  let contextUserId = session.created_by as UserID | undefined;

  if (taskId && deps.tasksService) {
    try {
      const task = await deps.tasksService.get(taskId);
      if (task?.created_by) {
        contextUserId = task.created_by as UserID;
      }
    } catch (_err) {
      // Fall back to session owner if task not found
    }
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

  // Render Agor system prompt with full session/worktree/repo context
  const agorSystemPrompt = await renderAgorSystemPrompt(sessionId, {
    sessions: deps.sessionsRepo,
    worktrees: deps.worktreesRepo,
    repos: deps.reposRepo,
  });

  const queryOptions: Record<string, unknown> = {
    cwd,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: agorSystemPrompt, // Append rich Agor context (session, worktree, repo)
    },
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

  // Add permissionMode if provided, otherwise fall back to session's permission_config
  // For Claude Code sessions, the UI should pass Claude SDK permission modes directly:
  // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  const effectivePermissionMode = permissionMode || session.permission_config?.mode;
  if (effectivePermissionMode) {
    queryOptions.permissionMode = effectivePermissionMode;
    console.log(
      `🔐 Permission mode: ${queryOptions.permissionMode}${permissionMode ? ' (from request)' : ' (from session config)'}`
    );
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

  // Add canUseTool callback if permission service is available and taskId provided
  // This enables Agor's custom permission UI (WebSocket-based) when SDK would show a prompt
  // Fires AFTER SDK checks settings.json - respects user's existing Claude CLI permissions!
  // IMPORTANT: Only skip for bypassPermissions (which never asks for permissions)
  if (deps.permissionService && taskId && effectivePermissionMode !== 'bypassPermissions') {
    queryOptions.canUseTool = createCanUseToolCallback(sessionId, taskId, {
      permissionService: deps.permissionService,
      tasksService: deps.tasksService!,
      sessionsRepo: deps.sessionsRepo,
      messagesRepo: deps.messagesRepo!,
      messagesService: deps.messagesService,
      sessionsService: deps.sessionsService,
      permissionLocks: deps.permissionLocks,
    });
    console.log(`✅ canUseTool callback added (permission mode: ${effectivePermissionMode})`);
    console.log(`   SDK will check settings.json first, then call Agor UI if needed`);
    console.log(`   Using SDK's built-in permission persistence (updatedPermissions)`);
  }

  // Add optional apiKey if provided
  // NOTE: Don't require API key - user may have used `claude login` (OAuth)
  // API keys are already resolved by base-executor with proper precedence (user → config → env)
  // If deps.apiKey is provided, use it directly (no need to check process.env)
  if (deps.apiKey) {
    queryOptions.apiKey = deps.apiKey;
  }

  // Resolve user environment variables
  // In executor mode, environment is inherited from the executor process
  const userEnv = resolveUserEnvironment();
  const originalProcessEnv = { ...process.env };
  let userEnvCount = 0;

  if (contextUserId) {
    try {
      // Count how many user env vars we're using (from inherited environment)
      const systemVarCount = Object.keys(originalProcessEnv).length;
      const totalVarCount = Object.keys(userEnv.env).length;
      userEnvCount = totalVarCount - systemVarCount;

      if (userEnvCount > 0) {
        console.log(
          `🔐 Using ${userEnvCount} environment vars for user ${contextUserId.substring(0, 8)}`
        );
      }
    } catch (err) {
      console.error(`⚠️  Failed to resolve user environment:`, err);
      // Continue without user env vars - non-fatal error
    }
  }

  // Handle resume, fork, and spawn cases
  if (resume) {
    // IMPORTANT DISTINCTION:
    // - FORK (forked_from_session_id) = should resume from parent SDK session with forkSession:true
    // - SPAWN (parent_session_id only) = should start FRESH, no resume, no fork

    const forkedFromSessionId = session.genealogy?.forked_from_session_id;
    const parentSessionId = session.genealogy?.parent_session_id;

    // CASE 1: Fork on first prompt (has forked_from_session_id, no sdk_session_id yet)
    if (forkedFromSessionId && !session.sdk_session_id && deps.sessionsRepo) {
      // This is a FORK - load parent's sdk_session_id and fork from it
      const parentSession = await deps.sessionsRepo.findById(forkedFromSessionId);

      if (parentSession?.sdk_session_id) {
        queryOptions.resume = parentSession.sdk_session_id;
        queryOptions.forkSession = true; // SDK will create new session ID from parent's history
        console.log(
          `🍴 Forking from parent session: ${parentSession.sdk_session_id.substring(0, 8)}`
        );
        console.log(`   SDK will return new session ID for this fork`);
      } else {
        console.warn(
          `⚠️  Parent session ${forkedFromSessionId.substring(0, 8)} has no sdk_session_id - starting fresh`
        );
      }
    }
    // CASE 1b: Spawn on first prompt (has parent_session_id but NOT forked_from_session_id)
    else if (parentSessionId && !forkedFromSessionId && !session.sdk_session_id) {
      // This is a SPAWN - start FRESH, do NOT resume from parent
      console.log(
        `🌱 Spawning fresh session (parent: ${parentSessionId.substring(0, 8)}) - NOT forking SDK session`
      );
      console.log(`   Child will start with clean context (spawns don't inherit parent history)`);
      // Don't set queryOptions.resume - let it start completely fresh
    }
    // CASE 2: Normal resume (session has its own sdk_session_id)
    else if (session?.sdk_session_id) {
      // Check if MCP servers were added after session creation
      // Claude Agent SDK locks in MCP configuration at session creation time
      // If MCP servers were added later, we need to start fresh to pick them up
      let mcpServersAddedAfterCreation = false;
      if (deps.sessionMCPRepo) {
        try {
          const sessionMCPServers = await deps.sessionMCPRepo.listServersWithMetadata(
            sessionId,
            true
          );
          const sessionCreatedAt = new Date(session.created_at).getTime();
          const sessionLastUpdated = session.last_updated
            ? new Date(session.last_updated).getTime()
            : sessionCreatedAt;
          const sessionReferenceTime = Math.max(sessionCreatedAt, sessionLastUpdated);

          for (const sms of sessionMCPServers) {
            if (sms.enabled && sms.added_at > sessionReferenceTime) {
              mcpServersAddedAfterCreation = true;
              const minutesAfterReference = Math.round(
                (sms.added_at - sessionReferenceTime) / 1000 / 60
              );
              console.warn(
                `⚠️  [MCP] Server "${sms.server.name}" was added ${minutesAfterReference} minute(s) after the session last updated`
              );
              break;
            }
          }
        } catch (error) {
          console.warn('⚠️  Failed to check MCP server timestamps:', error);
        }
      }

      if (mcpServersAddedAfterCreation) {
        console.warn(
          `⚠️  [MCP] MCP servers were added after the last SDK sync - current session won't see them!`
        );
        console.warn(`   🔧 SOLUTION: Clearing sdk_session_id to force fresh session start`);
        console.warn(
          `   Previous SDK session: ${session.sdk_session_id.substring(0, 8)} (will be discarded)`
        );

        // Clear SDK session ID to force fresh start with new MCP config
        if (deps.sessionsRepo) {
          await deps.sessionsRepo.update(sessionId, { sdk_session_id: undefined });
          // Update in-memory session object to match database
          session.sdk_session_id = undefined;
        }
        // Don't set queryOptions.resume - start fresh
      } else {
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
      // Get daemon URL from config (supports Codespaces auto-detection)
      const daemonUrl = await getDaemonUrl();

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

      // Check if session has explicitly configured MCP servers
      // biome-ignore lint/suspicious/noExplicitAny: MCPServer type from repository
      let sessionServers: any[] = [];
      if (session && deps.sessionMCPRepo) {
        sessionServers = await deps.sessionMCPRepo!.listServers(sessionId, true); // enabledOnly
      }

      // If session has explicit MCP servers, use ONLY those (no hierarchical inheritance)
      // This allows sessions to have isolated MCP configurations
      if (sessionServers.length > 0) {
        console.log('🔌 Using session-specific MCP servers (isolated mode)...');
        console.log(`   📍 Session scope: ${sessionServers.length} server(s)`);
        for (const server of sessionServers) {
          allServers.push({ server, source: 'session' });
        }
      } else {
        // Session has no explicit MCP servers - fall back to hierarchical scoping
        console.log('🔌 Fetching MCP servers with hierarchical scoping...');

        // 1. Global servers
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

          try {
            const headers = await resolveMCPAuthHeaders(server.auth);
            if (headers && server.transport !== 'stdio') {
              serverConfig.headers = headers;
              console.log(`     🔐 Added Authorization header for ${server.name}`);
            }
          } catch (error) {
            console.warn(
              `   ⚠️  Failed to resolve MCP auth headers for ${server.name}:`,
              error instanceof Error ? error.message : String(error)
            );
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
    console.error(`   API key set: ${deps.apiKey ? 'YES' : 'NO'}`);
    console.error(`   Resume session: ${queryOptions.resume || 'none (fresh session)'}`);
    throw syncError;
  }

  // Store stderr buffer getter for error reporting
  const getStderr = () => stderrBuffer;

  return { query: result, resolvedModel: model, getStderr };
}
