/**
 * Query Builder for Claude Agent SDK
 *
 * Handles query setup, configuration, and session initialization.
 * Manages MCP server configuration, resume/fork/spawn logic, and working directory validation.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { shortId, validateDirectory } from '@agor/core';
import { Claude } from '@agor/core/sdk';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import { isGatewaySession } from '@agor/core/types';

const { query } = Claude;
type PermissionMode = Claude.PermissionMode;
type Options = Claude.Options;

import { getDaemonUrl, resolveUserEnvironment } from '../../config.js';
import type {
  BranchRepository,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { MCPServersConfig, SessionID, TaskID } from '../../types.js';
import { resolveContextUserId } from '../base/context-user.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import { CLAUDE_CODE_DISALLOWED_TOOLS } from './constants.js';
import { parseModelWithBetas } from './model-utils.js';
import { DEFAULT_CLAUDE_MODEL } from './models.js';
import { createCanUseToolCallback } from './permissions/permission-hooks.js';

function summarizeMcpConfigCounts(config: unknown): string {
  if (!config || typeof config !== 'object') return 'none';

  let total = 0;
  let remote = 0;
  let stdio = 0;
  let withEnv = 0;

  for (const server of Object.values(config as MCPServersConfig)) {
    total += 1;
    const type = server.type || 'stdio';
    if (type === 'stdio') {
      stdio += 1;
    } else {
      remote += 1;
    }
    if (server.env && Object.keys(server.env).length > 0) {
      withEnv += 1;
    }
  }

  return `total=${total} remote=${remote} stdio=${stdio} with_env=${withEnv}`;
}

export function formatListForLog(items: string[], maxItems = 5): string {
  if (items.length <= maxItems) {
    return items.join(', ');
  }
  return `${items.slice(0, maxItems).join(', ')} +${items.length - maxItems} more`;
}

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
  console.log(`🤖 Prompting Claude for session ${shortId(sessionId)}...`);
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
  sessionsService?: SessionsPatchClient;
  messagesService?: MessagesService;
  branchesRepo?: BranchRepository;
  usersRepo?: UsersRepository;
  permissionLocks: Map<SessionID, Promise<void>>;
  mcpEnabled?: boolean;
}

/**
 * Setup and configure query for Claude Agent SDK
 * Handles session loading, CWD resolution, MCP configuration, and resume/fork/spawn logic
 */
/**
 * Type for Claude SDK Query object - an AsyncGenerator with interrupt() method
 * Note: We use `any` for the iterator type because the SDK returns complex union types
 * that include user messages, assistant messages, stream events, results, etc.
 * The actual runtime type is validated by SDKMessageProcessor.
 */
export interface InterruptibleQuery {
  interrupt(): Promise<void>;
  getContextUsage(): Promise<import('@agor/core/sdk').SDKControlGetContextUsageResponse>;
  /**
   * Signal that post-result control requests (like getContextUsage) are done.
   * This releases the held AsyncIterable, allowing the SDK to close stdin.
   * Must be called after the result event is fully processed.
   */
  releaseInput(): void;
  // biome-ignore lint/suspicious/noExplicitAny: SDK returns complex union of message types
  [Symbol.asyncIterator](): AsyncIterator<any>;
}

export async function setupQuery(
  sessionId: SessionID,
  prompt: string,
  deps: QuerySetupDeps,
  options: {
    taskId?: TaskID;
    permissionMode?: PermissionMode;
    resume?: boolean;
    abortController?: AbortController;
  } = {}
): Promise<{
  query: InterruptibleQuery;
  resolvedModel: string;
  getStderr: () => string;
}> {
  const { taskId, permissionMode, resume = true, abortController } = options;

  const session = await deps.sessionsRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const shouldBlockOnMcpStartup = isGatewaySession(session);

  // Determine which user's context to use for environment variables and API
  // keys: the task creator (prompter) when known, else the session owner.
  const contextUserId = await resolveContextUserId({
    session,
    taskId,
    tasksService: deps.tasksService,
  });
  console.log(`[Query Builder] Resolved contextUserId: ${contextUserId || 'NOT SET'}`);

  // Determine model to use (session config or default)
  // Models may include [1m] suffix for extended context — strip it for SDK and add beta flag
  const modelConfig = session.model_config;
  const rawModel = modelConfig?.model || DEFAULT_CLAUDE_MODEL;
  const { model, betas } = parseModelWithBetas(rawModel);
  const sdkBetas = new Set(betas);

  // Determine CWD from branch (if session has one)
  let cwd = process.cwd();
  if (session.branch_id && deps.branchesRepo) {
    try {
      const branch = await deps.branchesRepo.findById(session.branch_id);
      if (branch) {
        cwd = branch.path;
        console.log(`✅ Using branch path as cwd: ${cwd}`);
      } else {
        console.warn(
          `⚠️  Session ${sessionId} references non-existent branch ${session.branch_id}, using process.cwd(): ${cwd}`
        );
      }
    } catch (error) {
      console.error(`❌ Failed to fetch branch ${session.branch_id}:`, error);
      console.warn(`   Falling back to process.cwd(): ${cwd}`);
    }
  } else {
    console.warn(`⚠️  Session ${sessionId} has no branch_id, using process.cwd(): ${cwd}`);
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
        console.warn(`⚠️  Working directory is EMPTY - branch may be from bare repo!`);
      } else if (!hasGit) {
        console.warn(`⚠️  Working directory has no .git - not a valid branch!`);
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
        session.branch_id
          ? ` Session references branch ${session.branch_id} which may not be initialized.`
          : ''
      }`
    );
  }

  // Get Claude Code path
  const claudeCodePath = getClaudeCodePath();

  // Buffer to capture stderr for better error messages
  let stderrBuffer = '';

  // Render Agor system prompt with full session/branch/repo context
  const agorSystemPrompt = await renderAgorSystemPrompt(sessionId, {
    sessions: deps.sessionsRepo,
    branches: deps.branchesRepo,
    repos: deps.reposRepo,
    users: deps.usersRepo,
  });

  const queryOptions: Record<string, unknown> = {
    cwd,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: agorSystemPrompt, // Append rich Agor context (session, branch, repo)
    },
    settingSources: ['user', 'project', 'local'], // Load user + project + local permissions, auto-loads CLAUDE.md
    // Defensive copy — the const is readonly but the SDK option is typed `string[]`.
    disallowedTools: [...CLAUDE_CODE_DISALLOWED_TOOLS],
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

  // Pass AbortController to SDK for proper cancellation support
  // This is the officially supported way to stop a query mid-execution
  // See: https://platform.claude.com/docs/en/agent-sdk/typescript
  if (abortController) {
    queryOptions.abortController = abortController;
    console.log(`🛑 AbortController attached to query for cancellation support`);
  }

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

  // Configure effort level — controls reasoning depth via SDK's effort parameter
  // Matches Claude Code CLI's --effort flag (low/medium/high/max)
  const effort = session.model_config?.effort;
  if (effort) {
    queryOptions.effort = effort;
    console.log(`🧠 Effort level: ${effort}`);
  } else {
    console.log(`🧠 Effort level: high (default)`);
  }

  // Configure Claude Code's server-side advisor tool model when a session-level
  // override is present. Pass it through the CLI's first-class `--advisor` flag
  // (via the SDK's `extraArgs`) — NOT through the `settings` object.
  //
  // Why not `settings`: passing `settings` as an object makes the Agent SDK emit
  // `--settings '<inline JSON>'`, which the Claude CLI can materialize into a
  // CONTENT-ADDRESSED temp file at `${os.tmpdir()}/claude-settings-<hash>.json`
  // when it hands the resolved flag-settings layer to its workers. In the daemon,
  // `os.tmpdir()` resolves to the shared, sticky-bit `/tmp` (the daemon runs with
  // TMPDIR stripped), so every session with identical advisor settings targets the
  // SAME path. The first writer owns it mode 0600; later sessions — or other Unix
  // users under insulated/strict isolation — then fail to open it with
  // `EACCES ... claude-settings-*.json`, crashing the CLI before the first message.
  // `--advisor <model>` is the CLI's dedicated, server-validated flag (Claude Code
  // >= 2.1.175) and writes no settings file, so it sidesteps the collision entirely.
  const rawAdvisorModel = session.model_config?.advisorModel?.trim();
  if (rawAdvisorModel) {
    const { model: advisorModel, betas: advisorBetas } = parseModelWithBetas(rawAdvisorModel);
    for (const beta of advisorBetas) sdkBetas.add(beta);
    const extraArgs = (queryOptions.extraArgs as Record<string, string | null> | undefined) ?? {};
    extraArgs.advisor = advisorModel;
    queryOptions.extraArgs = extraArgs;
    console.log(`🧭 Advisor model: ${advisorModel} (via --advisor)`);
  }

  // Add beta flags (e.g., 1M context window for [1m] model variants)
  const betaList = [...sdkBetas];
  if (betaList.length > 0) {
    queryOptions.betas = betaList;
    console.log(`🔬 Beta flags: ${betaList.join(', ')}`);
  }

  // Add canUseTool callback if permission service is available and taskId provided.
  // This enables Agor's custom permission UI (WebSocket-based) when the SDK would
  // show a prompt. Fires AFTER the SDK checks settings.json — respects user's
  // existing Claude CLI permissions.
  //
  // Skip in bypassPermissions mode: the SDK skips canUseTool there anyway, and
  // we no longer need a workaround to intercept AskUserQuestion (now disallowed).
  if (
    deps.permissionService &&
    taskId &&
    deps.sessionMCPRepo &&
    deps.mcpServerRepo &&
    effectivePermissionMode !== 'bypassPermissions'
  ) {
    queryOptions.canUseTool = createCanUseToolCallback(sessionId, taskId, {
      permissionService: deps.permissionService,
      tasksService: deps.tasksService!,
      messagesRepo: deps.messagesRepo!,
      messagesService: deps.messagesService,
      sessionsService: deps.sessionsService,
      permissionLocks: deps.permissionLocks,
      mcpServerRepo: deps.mcpServerRepo,
      sessionMCPRepo: deps.sessionMCPRepo,
    });
    console.log(`✅ canUseTool callback added (permission mode: ${effectivePermissionMode})`);
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
        console.log(`🔐 Using ${userEnvCount} environment vars for user ${shortId(contextUserId)}`);
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
        console.log(`🍴 Forking from parent session: ${shortId(parentSession.sdk_session_id)}`);
        console.log(`   SDK will return new session ID for this fork`);
      } else {
        console.warn(
          `⚠️  Parent session ${shortId(forkedFromSessionId)} has no sdk_session_id - starting fresh`
        );
      }
    }
    // CASE 1b: Spawn on first prompt (has parent_session_id but NOT forked_from_session_id)
    else if (parentSessionId && !forkedFromSessionId && !session.sdk_session_id) {
      // This is a SPAWN - start FRESH, do NOT resume from parent
      console.log(
        `🌱 Spawning fresh session (parent: ${shortId(parentSessionId)}) - NOT forking SDK session`
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
          `   Previous SDK session: ${shortId(session.sdk_session_id)} (will be discarded)`
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
          !session.branch_id; // No branch = can't resume properly

        if (isLikelyStale) {
          console.warn(
            `⚠️  Resume session ${shortId(session.sdk_session_id)} appears stale (${Math.round(hoursSinceUpdate)}h old) - starting fresh`
          );

          // Clear stale session ID to prevent exit code 1
          if (deps.sessionsRepo) {
            await deps.sessionsRepo.update(sessionId, { sdk_session_id: undefined });
          }
          // Don't set queryOptions.resume - start fresh
        } else {
          queryOptions.resume = session.sdk_session_id;
          console.log(`   Resuming SDK session: ${shortId(session.sdk_session_id)}`);
        }
      }
    }
    // CASE 3: Fresh session (no genealogy, no sdk_session_id)
    // -> queryOptions.resume not set, SDK will start fresh and return new session ID
  }

  // Configure Agor MCP server (self-access to daemon) - only if MCP is enabled
  if (deps.mcpEnabled !== false) {
    const mcpToken = session.mcp_token;

    if (mcpToken) {
      // Get daemon URL from config
      const daemonUrl = await getDaemonUrl();

      console.log(`🔌 Configuring Agor MCP server at ${daemonUrl}/mcp`);
      const mcpConfig = {
        agor: {
          type: 'http' as const,
          url: `${daemonUrl}/mcp`,
          headers: {
            Authorization: `Bearer ${mcpToken}`,
          },
          ...(shouldBlockOnMcpStartup ? { alwaysLoad: true } : {}),
        },
      };
      queryOptions.mcpServers = mcpConfig;
    } else {
      console.warn(
        `⚠️  No MCP token found for session ${shortId(sessionId)} - MCP tools unavailable`
      );
    }
  }

  // Fetch and configure MCP servers for this session
  if (deps.sessionMCPRepo && deps.mcpServerRepo) {
    try {
      // Use shared MCP scoping utility
      // Pass forUserId to enable per-user OAuth token injection
      const serversWithSource = await getMcpServersForSession(sessionId, {
        sessionMCPRepo: deps.sessionMCPRepo,
        mcpServerRepo: deps.mcpServerRepo,
        forUserId: contextUserId,
      });

      if (serversWithSource.length > 0) {
        // Convert to SDK format
        const mcpConfig: MCPServersConfig = {};
        const allowedTools: string[] = [];
        let remoteServerCount = 0;
        let stdioServerCount = 0;
        let serversWithHeaders = 0;
        const missingAuthServers: string[] = [];
        const unresolvedAuthServers: string[] = [];

        for (const { server } of serversWithSource) {
          // Infer transport if missing (backwards compatibility)
          const transport = server.transport || (server.url ? 'sse' : 'stdio');
          if (transport === 'stdio') {
            stdioServerCount += 1;
          } else {
            remoteServerCount += 1;
          }

          // Build server config (convert 'transport' field to 'type' for Claude Code)
          const serverConfig: Record<string, unknown> = {
            type: transport,
            env: server.env,
          };
          let canAlwaysLoad = shouldBlockOnMcpStartup;

          // Add transport-specific fields
          if (transport === 'stdio') {
            serverConfig.command = server.command;
            serverConfig.args = server.args || [];
          } else {
            // http and sse both use url
            serverConfig.url = server.url;
          }

          try {
            // Pass mcpUrl for OAuth token cache lookup
            const authHeaders = await resolveMCPAuthHeaders(server.auth, server.url);
            const missingRequiredAuth =
              !!server.auth &&
              server.auth.type !== 'none' &&
              transport !== 'stdio' &&
              !authHeaders?.Authorization;
            const headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
            if (headers && transport !== 'stdio') {
              serverConfig.headers = headers;
              serversWithHeaders += 1;
            }
            if (missingRequiredAuth) {
              // Auth-backed remote server but no usable token. Track one concise summary below.
              missingAuthServers.push(server.name);
              canAlwaysLoad = false;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            unresolvedAuthServers.push(`${server.name}: ${message}`);
            canAlwaysLoad = false;
          }

          if (canAlwaysLoad) {
            serverConfig.alwaysLoad = true;
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
        // Log one safe summary line. Env/header values may contain secrets after template resolution.
        console.log(
          `   🔧 MCP servers configured: total=${serversWithSource.length} remote=${remoteServerCount} ` +
            `stdio=${stdioServerCount} headers=${serversWithHeaders} missing_auth=${missingAuthServers.length} ` +
            `auth_errors=${unresolvedAuthServers.length}`
        );
        if (missingAuthServers.length > 0) {
          console.warn(
            `   ⚠️  ${missingAuthServers.length} MCP server(s) have configured auth but no valid token: ` +
              `${formatListForLog(missingAuthServers)}. Check Settings → MCP Servers.`
          );
        }
        if (unresolvedAuthServers.length > 0) {
          console.warn(
            `   ⚠️  Failed to resolve MCP auth for ${unresolvedAuthServers.length} server(s): ` +
              formatListForLog(unresolvedAuthServers, 3)
          );
        }
        if (allowedTools.length > 0) {
          queryOptions.allowedTools = allowedTools;
          console.log(`   🔧 MCP tools allowlist: ${allowedTools.length} tool(s)`);
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
  // Log safe MCP counts only. Per-server names/details are intentionally omitted from this per-query log.
  console.log(`   MCP servers: ${summarizeMcpConfigCounts(queryOptions.mcpServers)}`);

  // Wrap the string prompt in an AsyncIterable so the SDK treats this as a
  // streaming-input query.  When a plain string is passed, the SDK sets
  // `isSingleUserTurn = true` and closes stdin right after the first result
  // event.  Even with an iterable, the SDK calls `transport.endInput()` once
  // the iterable is fully consumed (after streamInput finishes).  So we must
  // keep the iterable alive until AFTER post-result control requests like
  // `getContextUsage()` complete.
  //
  // The iterable yields the user message, then blocks on a Promise that is
  // resolved by calling `releaseInput()`.  This keeps stdin open until we
  // explicitly signal that we're done with control requests.
  let releaseInputResolve: (() => void) | undefined;
  const inputHeldPromise = new Promise<void>((resolve) => {
    releaseInputResolve = resolve;
  });

  async function* asUserMessageIterable(text: string) {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content: [{ type: 'text' as const, text }] },
      parent_tool_use_id: null,
    };
    // Hold the iterable open until releaseInput() is called, keeping stdin alive
    await inputHeldPromise;
  }

  let result: AsyncGenerator<unknown>;
  try {
    result = query({
      prompt: asUserMessageIterable(prompt),
      // queryOptions uses Record<string,unknown> to accommodate undocumented fields (debug, apiKey)
      // that are valid at runtime but not in the public Options type
      options: queryOptions as unknown as Options,
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

  // Attach releaseInput() so callers can signal when post-result control requests are done.
  // The SDK's query() returns an AsyncGenerator with interrupt()/getContextUsage() methods.
  const queryObj = result as unknown as InterruptibleQuery;
  queryObj.releaseInput = () => {
    releaseInputResolve?.();
  };

  return {
    query: queryObj,
    resolvedModel: model,
    getStderr,
  };
}
