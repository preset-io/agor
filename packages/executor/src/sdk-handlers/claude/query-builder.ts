/**
 * Query Builder for Claude Agent SDK
 *
 * Handles query setup, configuration, and session initialization.
 * Manages MCP server configuration, resume/fork/spawn logic, and working directory validation.
 */

import * as fs from 'node:fs/promises';
import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';
import { shortId } from '@agor/core/db';
import { validateDirectory } from '@agor/core/lib/validation';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import { isGatewaySession, type PromptOrigin } from '@agor/core/types';
import type * as ClaudeSdk from '@anthropic-ai/claude-agent-sdk';
import { McpAuthDiagnosticAccumulator } from '../../diagnostics/mcp-auth-diagnostic-accumulator.js';

type PermissionMode = ClaudeSdk.PermissionMode;
type Options = ClaudeSdk.Options;

import {
  AGOR_MCP_SERVER_NAME,
  getMcpServersForSession,
  listMcpToolsWithPermission,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
  resolveScopedMCPAuthHeaders,
  sanitizeMCPExternalError,
} from '@agor/core/mcp';
import { getDaemonUrl } from '../../config.js';
import type {
  BranchRepository,
  MCPOAuthAuthHeadersRepository,
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
} from '../../db/feathers-repositories.js';
import type { PermissionService } from '../../permissions/permission-service.js';
import type { MCPServersConfig, SessionID, TaskID } from '../../types.js';
import { resolveExecutorWorkingDirectory } from '../../user-runtime-paths.js';
import { resolveContextUserId } from '../base/context-user.js';
import type { MessagesService, SessionsPatchClient, TasksService } from '../base/index.js';
import { createMcpToolPermissionHook } from '../base/mcp-tool-permission-hook.js';
import {
  buildMcpToolPermissionIndex,
  EMPTY_MCP_TOOL_PERMISSION_INDEX,
  mcpToolNameAliasesForServer,
  mcpToolNameAliasesForTool,
} from '../base/mcp-tool-permissions.js';
import { createCanUseToolCallback } from '../base/permission-hooks.js';
import { CLAUDE_CODE_DISALLOWED_TOOLS } from './constants.js';
import { DEFAULT_CLAUDE_MODEL } from './models.js';

export function formatListForLog(items: string[], maxItems = 5): string {
  if (items.length <= maxItems) {
    return items.join(', ');
  }
  return `${items.slice(0, maxItems).join(', ')} +${items.length - maxItems} more`;
}

/**
 * Log prompt start with context
 */
function logPromptStart(sessionId: SessionID) {
  console.log(`🤖 Prompting Claude for session ${shortId(sessionId)}...`);
}

export interface QuerySetupDeps {
  sessionsRepo: SessionRepository;
  reposRepo?: RepoRepository;
  messagesRepo?: MessagesRepository;
  apiKey?: string;
  sessionMCPRepo?: SessionMCPServerRepository;
  mcpServerRepo?: MCPServerRepository;
  mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository;
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
  /**
   * Finalize the Query. The SDK Query's own `return()` runs `cleanup()` FIRST —
   * closing the transport/stdin — and only then delegates to the inner message
   * generator's `return()`. Closing the transport is what resolves an
   * outstanding `next()` read, so this (unlike `[Symbol.asyncIterator]().return()`,
   * which is serialized behind that pending read) is the correct teardown when a
   * held read never settles on its own. Bounded by callers because
   * `cleanup()` awaits the subprocess exit.
   */
  return(value?: unknown): Promise<IteratorResult<unknown>>;
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
    promptOrigin?: PromptOrigin;
  } = {}
): Promise<{
  query: InterruptibleQuery;
  resolvedModel: string;
  getStderrMetadata: () => { hasStderr: boolean; byteLength: number };
}> {
  const { taskId, permissionMode, resume = true, abortController, promptOrigin } = options;

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

  // Determine model to use (session config or default)
  // `[1m]` is a first-class Claude Code model-selection suffix. Keep it on
  // the SDK model option so Claude Code can apply provider/account entitlement,
  // compaction, and routing consistently; it strips the suffix at the provider
  // boundary itself.
  const modelConfig = session.model_config;
  const model = modelConfig?.model || DEFAULT_CLAUDE_MODEL;

  // Determine CWD from branch (if session has one)
  let cwd = process.cwd();
  if (session.branch_id && deps.branchesRepo) {
    try {
      const branch = await deps.branchesRepo.findById(session.branch_id);
      if (branch) {
        cwd = resolveExecutorWorkingDirectory(branch.path);
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

  logPromptStart(sessionId);

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

  // Provider stderr may contain MCP URLs/headers, credentials, or reflected
  // payloads. Retain only bounded scalar metadata; raw bytes never cross this
  // callback or become available to later logging code.
  let stderrByteLength = 0;

  // Append static Agor orientation. Dynamic context is available through Agor MCP.
  const agorSystemPrompt = await renderAgorSystemPrompt();

  const queryOptions: Record<string, unknown> = {
    cwd,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: agorSystemPrompt,
    },
    settingSources: ['user', 'project', 'local'], // Load user + project + local permissions, auto-loads CLAUDE.md
    // Defensive copy — the const is readonly but the SDK option is typed `string[]`.
    disallowedTools: [...CLAUDE_CODE_DISALLOWED_TOOLS],
    model, // Use configured model or default
    // Allow access to common directories outside CWD (e.g., /tmp)
    additionalDirectories: ['/tmp', '/var/tmp'],
    // Enable token-level streaming (yields partial messages as tokens arrive)
    includePartialMessages: true,
    stderr: (data: unknown) => {
      const chunkByteLength =
        typeof data === 'string'
          ? Buffer.byteLength(data)
          : Buffer.isBuffer(data)
            ? data.length
            : 0;
      stderrByteLength = Math.min(Number.MAX_SAFE_INTEGER, stderrByteLength + chunkByteLength);
    },
  };

  // Pass AbortController to SDK for proper cancellation support
  // This is the officially supported way to stop a query mid-execution
  // See: https://platform.claude.com/docs/en/agent-sdk/typescript
  if (abortController) {
    queryOptions.abortController = abortController;
  }

  // Add permissionMode if provided, otherwise fall back to session's permission_config
  // For Claude Code sessions, the UI should pass Claude SDK permission modes directly:
  // 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  const effectivePermissionMode = permissionMode || session.permission_config?.mode;
  if (effectivePermissionMode) {
    queryOptions.permissionMode = effectivePermissionMode;
  }

  // Configure effort level — controls reasoning depth via SDK's effort parameter
  // Matches Claude Code CLI's --effort flag (low/medium/high/max)
  const effort = session.model_config?.effort;
  if (effort) {
    queryOptions.effort = effort;
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
  // users in separate execution homes — then fail to open it with
  // `EACCES ... claude-settings-*.json`, crashing the CLI before the first message.
  // `--advisor <model>` is the CLI's dedicated, server-validated flag (Claude Code
  // >= 2.1.175) and writes no settings file, so it sidesteps the collision entirely.
  const rawAdvisorModel = session.model_config?.advisorModel?.trim();
  if (rawAdvisorModel) {
    const extraArgs = (queryOptions.extraArgs as Record<string, string | null> | undefined) ?? {};
    extraArgs.advisor = rawAdvisorModel;
    queryOptions.extraArgs = extraArgs;
  }

  // Add optional apiKey if provided
  // NOTE: Don't require API key - user may have used `claude login` (OAuth)
  // API keys are already resolved by base-executor with proper precedence (user → config → env)
  // If deps.apiKey is provided, use it directly (no need to check process.env)
  if (deps.apiKey) {
    queryOptions.apiKey = deps.apiKey;
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
      } else {
        console.warn(
          `⚠️  Parent session ${shortId(forkedFromSessionId)} has no sdk_session_id - starting fresh`
        );
      }
    }
    // CASE 1b: Spawn on first prompt (has parent_session_id but NOT forked_from_session_id)
    else if (parentSessionId && !forkedFromSessionId && !session.sdk_session_id) {
      // This is a SPAWN - start FRESH, do NOT resume from parent
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
        } catch {
          console.warn('⚠️  Failed to check MCP server timestamps');
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
          await deps.sessionsRepo.update(sessionId, { sdk_session_id: null });
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
            await deps.sessionsRepo.update(sessionId, { sdk_session_id: null });
          }
          // Don't set queryOptions.resume - start fresh
        } else {
          queryOptions.resume = session.sdk_session_id;
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

  // Whether this query will have a live approval channel back to the UI.
  // Decided up front because MCP `tool_permissions` need it: an "ask" tool with
  // nowhere to ask has to fail closed rather than silently become "allow".
  const canPromptForPermission = Boolean(
    deps.permissionService &&
      taskId &&
      deps.sessionMCPRepo &&
      deps.mcpServerRepo &&
      effectivePermissionMode !== 'bypassPermissions'
  );

  // Fetch and configure MCP servers for this session
  let mcpToolPermissions = EMPTY_MCP_TOOL_PERMISSION_INDEX;
  if (deps.sessionMCPRepo && deps.mcpServerRepo) {
    try {
      // Use shared MCP scoping utility
      // Pass forUserId to enable per-user OAuth token injection
      const serversWithSource = await getMcpServersForSession(
        sessionId,
        {
          sessionMCPRepo: deps.sessionMCPRepo,
          mcpServerRepo: deps.mcpServerRepo,
          mcpOAuthAuthHeadersRepo: deps.mcpOAuthAuthHeadersRepo,
          forUserId: contextUserId,
        },
        { toolFiltering: 'exclude' }
      );

      // The built-in Agor server carries this session's daemon bearer token and
      // is auto-approved by name in canUseTool. Drop any DB server claiming that
      // name before anything reads the list, so it can neither be configured nor
      // contribute permissions that would gate the genuine built-in's tools.
      const attachableServers = serversWithSource.filter(({ server }) => {
        if (server.name !== AGOR_MCP_SERVER_NAME) return true;
        console.warn(
          `   ⚠️  Skipping MCP server "${server.name}": reserved for the built-in Agor MCP server`
        );
        return false;
      });

      mcpToolPermissions = buildMcpToolPermissionIndex(
        attachableServers.map(({ server }) => server)
      );

      if (attachableServers.length > 0) {
        // Convert to SDK format
        const mcpConfig: MCPServersConfig = {};
        const deniedTools: string[] = [];
        const authDiagnostics = new McpAuthDiagnosticAccumulator();

        for (const scoped of attachableServers) {
          const { server } = scoped; // Infer transport if missing (backwards compatibility)
          const transport = server.transport || (server.url ? 'sse' : 'stdio');

          // Build server config (convert 'transport' field to 'type' for Claude Code)
          const serverConfig: Record<string, unknown> = {
            type: transport,
            env: server.env,
          };
          let canAlwaysLoad =
            shouldBlockOnMcpStartup || (transport !== 'stdio' && server.auth?.type === 'oauth');

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
            const authHeaders = await resolveScopedMCPAuthHeaders(scoped, {
              surfaceAuthorityError: true,
            });
            const missingRequiredAuth =
              !!server.auth &&
              server.auth.type !== 'none' &&
              transport !== 'stdio' &&
              !authHeaders?.Authorization;
            const headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
            if (headers && transport !== 'stdio') {
              serverConfig.headers = headers;
            }
            if (missingRequiredAuth) {
              // Auth-backed remote server but no usable token. Track one concise summary below.
              authDiagnostics.recordUnavailable();
              canAlwaysLoad = false;
            }
          } catch {
            authDiagnostics.recordResolutionFailure();
            canAlwaysLoad = false;
          }

          if (canAlwaysLoad) {
            serverConfig.alwaysLoad = true;
          }

          mcpConfig[server.name] = serverConfig;

          // Denied tools are blocked at the SDK layer as well as in canUseTool,
          // so the model is never even offered a tool the user switched off.
          // Without an approval channel an "ask" tool is unanswerable, so it
          // joins them rather than degrading to "allow".
          const blocked = canPromptForPermission
            ? (['deny'] as const)
            : PERMISSIONS_BLOCKED_WITHOUT_PROMPT;
          for (const tool of listMcpToolsWithPermission(server, blocked)) {
            // The CLI rewrites BOTH halves into the tool-name alphabet before a
            // name reaches a rule, so either half carrying punctuation would
            // never match if only the raw form were listed. Every combination is
            // emitted; a rule that matches nothing is inert.
            for (const serverAlias of new Set(mcpToolNameAliasesForServer(server.name))) {
              for (const toolAlias of new Set(mcpToolNameAliasesForTool(tool))) {
                deniedTools.push(`mcp__${serverAlias}__${toolAlias}`);
              }
            }
          }
        }

        // Merge with existing MCP servers (preserve Agor MCP server)
        queryOptions.mcpServers = {
          ...(queryOptions.mcpServers || {}),
          ...mcpConfig,
        };
        authDiagnostics.emitSummary('claude');
        if (deniedTools.length > 0) {
          queryOptions.disallowedTools = [
            ...(queryOptions.disallowedTools as string[]),
            ...deniedTools,
          ];
        }
      }
    } catch (error) {
      const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
      console.warn(
        `⚠️  Failed to fetch MCP servers for session category=${safe.category} type=${safe.diagnostic.type}`
      );
      // Continue without MCP servers - non-fatal error
    }
  }

  // PreToolUse runs ahead of settings.json rule matching, so this is what stops
  // a stale persisted `allow` rule from skipping an `ask` gate entirely.
  if (mcpToolPermissions.byServer.size > 0) {
    queryOptions.hooks = {
      ...(queryOptions.hooks as Record<string, unknown> | undefined),
      PreToolUse: [
        { hooks: [createMcpToolPermissionHook(mcpToolPermissions, canPromptForPermission)] },
      ],
    };
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
      mcpToolPermissions,
    });
  }

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
      // Agent SDK 0.3.259 treats an omitted origin as unattributed at strict
      // human-trust gates. The daemon derives this value from durable Task and
      // Session state; synthesized prompts deliberately leave it undefined.
      ...(promptOrigin ? { origin: promptOrigin } : {}),
    };
    // Hold the iterable open until releaseInput() is called, keeping stdin alive
    await inputHeldPromise;
  }

  let result: AsyncGenerator<unknown>;
  try {
    const Claude = await loadManagedAgenticToolSdk<typeof ClaudeSdk>('claude-code');
    result = Claude.query({
      prompt: asUserMessageIterable(prompt),
      // queryOptions uses Record<string,unknown> to accommodate apiKey, which is valid at
      // runtime but not in the public Options type.
      options: queryOptions as unknown as Options,
    });
  } catch (syncError) {
    // This is rare - SDK usually returns AsyncGenerator that throws later
    const safe = sanitizeMCPExternalError(syncError, { stage: 'runtime' });
    console.error(
      `❌ CRITICAL: query() threw synchronously category=${safe.category} type=${safe.diagnostic.type}`
    );
    throw new Error(safe.message);
  }

  const getStderrMetadata = () => ({
    hasStderr: stderrByteLength > 0,
    byteLength: stderrByteLength,
  });

  // Attach releaseInput() so callers can signal when post-result control requests are done.
  // The SDK's query() returns an AsyncGenerator with interrupt()/getContextUsage() methods.
  const queryObj = result as unknown as InterruptibleQuery;
  queryObj.releaseInput = () => {
    releaseInputResolve?.();
  };

  return {
    query: queryObj,
    resolvedModel: model,
    getStderrMetadata,
  };
}
