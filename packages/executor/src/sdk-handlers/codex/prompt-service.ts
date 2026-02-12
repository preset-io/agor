/**
 * Codex Prompt Service
 *
 * Handles live execution of prompts against Codex sessions using OpenAI Codex SDK.
 * Wraps the @openai/codex-sdk for thread management and execution.
 *
 * IMPORTANT: This service caches the Codex SDK instance and only recreates it when
 * the API key or MCP server configuration actually changes. This prevents a memory leak
 * where new Codex CLI processes would be spawned on every prompt execution without cleanup.
 * See issue #133 for details.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Thread, ThreadItem } from '@agor/core/sdk';
import { Codex } from '@agor/core/sdk';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { type JsonMap, parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { getDaemonUrl } from '../../config.js';
import type {
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { TokenUsage } from '../../types/token-usage.js';
import type { PermissionMode, SessionID, TaskID } from '../../types.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import { DEFAULT_CODEX_MODEL } from './models.js';
import { extractCodexTokenUsage } from './usage.js';

export interface CodexPromptResult {
  /** Complete assistant response from Codex */
  messages: Array<{
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    toolUses?: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
  }>;
  /** Number of input tokens */
  inputTokens: number;
  /** Number of output tokens */
  outputTokens: number;
  /** Agent SDK thread ID for conversation continuity */
  threadId: string;
  /** Token usage (if provided by SDK) */
  tokenUsage?: TokenUsage;
  /** Resolved model for the turn */
  resolvedModel?: string;
}

/**
 * Streaming event types for Codex execution
 */
export type CodexStreamEvent =
  | {
      type: 'partial';
      textChunk: string;
      threadId?: string;
      resolvedModel?: string;
    }
  | {
      type: 'tool_start';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      };
      threadId?: string;
    }
  | {
      type: 'tool_complete';
      toolUse: {
        id: string;
        name: string;
        input: Record<string, unknown>;
        output?: string;
        status?: string;
      };
      threadId?: string;
    }
  | {
      type: 'stopped';
      threadId?: string;
    }
  | {
      type: 'complete';
      content: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      toolUses?: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;
      threadId: string;
      resolvedModel?: string;
      usage?: TokenUsage;
      rawSdkEvent?: import('../../types/sdk-response').CodexSdkResponse; // The actual turn.completed event from Codex SDK
    };

export class CodexPromptService {
  private codex: InstanceType<typeof Codex.Codex>;
  private lastMCPServersHash: string | null = null;
  private lastApiKey: string | null = null;
  private stopRequested = new Map<SessionID, boolean>();
  private apiKey: string | undefined;
  private lastCodexHome: string | null = null;

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private sessionMCPServerRepo?: SessionMCPServerRepository,
    private worktreesRepo?: WorktreeRepository,
    private reposRepo?: RepoRepository,
    apiKey?: string,
    private mcpServerRepo?: MCPServerRepository
  ) {
    // Store API key from base-executor (already resolved with proper precedence)
    this.apiKey = apiKey || '';
    this.lastApiKey = this.apiKey;
    // Initialize Codex SDK with resolved API key
    this.codex = new Codex.Codex({
      apiKey: this.apiKey,
    });
  }

  /**
   * Reinitialize Codex SDK to pick up config changes
   * Call this after updating ~/.codex/config.toml
   *
   * NOTE: This is only called when MCP server config changes, which requires
   * a full SDK restart to pick up the new config.toml file
   */
  private reinitializeCodex(): void {
    console.log('🔄 [Codex] Reinitializing SDK to pick up config changes...');
    // Use the resolved API key from base-executor (no fallback to env needed)
    this.codex = new Codex.Codex({
      apiKey: this.apiKey,
    });
    this.lastApiKey = this.apiKey || null;
    console.log('✅ [Codex] SDK reinitialized');
  }

  /**
   * Refresh Codex client with latest API key from config
   * Ensures hot-reload of credentials from Settings UI
   *
   * IMPORTANT: Only recreates Codex instance if API key actually changed
   * This prevents memory leak from spawning multiple Codex CLI processes
   */
  private refreshClient(currentApiKey: string): void {
    // Only recreate if API key changed (prevents memory leak - issue #133)
    if (this.lastApiKey !== currentApiKey) {
      console.log('🔄 [Codex] API key changed, reinitializing SDK...');
      this.codex = new Codex.Codex({
        apiKey: currentApiKey,
      });
      this.lastApiKey = currentApiKey;
      console.log('✅ [Codex] SDK reinitialized with new API key');
    }
  }

  /**
   * Create per-session CODEX_HOME with Agor context
   *
   * Codex SDK uses $CODEX_HOME environment variable to locate config/AGENTS.md.
   * We create a unique CODEX_HOME per session to:
   * 1. Avoid race conditions between concurrent sessions
   * 2. Inject rich session/worktree/repo context via AGENTS.md
   * 3. Preserve user's project AGENTS.md files (still loaded hierarchically)
   *
   * Returns the per-session CODEX_HOME path.
   */
  private async ensureCodexSessionContext(sessionId: SessionID): Promise<string> {
    const agorSystemPrompt = await renderAgorSystemPrompt(sessionId, {
      sessions: this.sessionsRepo,
      worktrees: this.worktreesRepo,
      repos: this.reposRepo,
    });

    // Create per-session CODEX_HOME (no race conditions!)
    // Use mode 0o700 (rwx------) to prevent other users from reading session metadata
    const sessionCodexHome = path.join(os.tmpdir(), `agor-codex-${sessionId}`);
    await fs.mkdir(sessionCodexHome, { recursive: true, mode: 0o700 });

    // Write session context to AGENTS.md
    // Use mode 0o600 (rw-------) to restrict file access
    const agentsMdPath = path.join(sessionCodexHome, 'AGENTS.md');
    await fs.writeFile(agentsMdPath, agorSystemPrompt, { encoding: 'utf-8', mode: 0o600 });

    console.log(`✅ [Codex] Created per-session CODEX_HOME at ${sessionCodexHome}`);
    console.log(`   Session context will be auto-loaded with any project AGENTS.md files`);

    return sessionCodexHome;
  }

  /**
   * Generate $CODEX_HOME/config.toml with approval_policy, network_access, and MCP servers
   *
   * NOTE: approval_policy, network_access, and MCP servers must be configured via config.toml
   * (not available in ThreadOptions). We minimize file writes by tracking a hash
   * of the configuration and only updating when it changes.
   *
   * Codex supports two MCP transport types in config.toml:
   * - STDIO: `command` + `args` + `env` fields
   * - Streamable HTTP: `url` + optional `bearer_token_env_var` / `http_headers` / `env_http_headers`
   *
   * The built-in Agor MCP server is automatically configured as a streamable HTTP server,
   * enabling Codex agents to access Agor resources (sessions, worktrees, boards, etc.)
   *
   * @param approvalPolicy - Codex approval policy (untrusted, on-request, on-failure, never)
   * @param networkAccess - Whether to allow outbound network access in workspace-write mode
   * @param sessionId - Session ID for fetching MCP servers
   * @param codexHome - Path to CODEX_HOME directory (per-session or global)
   * @param mcpToken - Optional MCP authentication token for the built-in Agor MCP server
   * @returns Number of MCP servers configured
   */
  private async ensureCodexConfig(
    approvalPolicy: 'untrusted' | 'on-request' | 'on-failure' | 'never',
    networkAccess: boolean,
    sessionId: SessionID,
    codexHome: string,
    mcpToken?: string
  ): Promise<number> {
    // Fetch MCP servers for this session using shared scoping utility
    // This includes both global-scoped and session-assigned servers with template resolution
    console.log(`🔍 [Codex MCP] Fetching MCP servers for session ${sessionId.substring(0, 8)}...`);

    const serversWithSource = await getMcpServersForSession(sessionId, {
      sessionMCPRepo: this.sessionMCPServerRepo,
      mcpServerRepo: this.mcpServerRepo,
    });

    const mcpServers = serversWithSource.map((s) => s.server);

    console.log(`📊 [Codex MCP] Found ${mcpServers.length} MCP server(s) for session`);
    if (mcpServers.length > 0) {
      console.log(`   Servers: ${mcpServers.map((s) => `${s.name} (${s.transport})`).join(', ')}`);
    }

    // Categorize servers by transport type
    // Codex supports both STDIO and streamable HTTP transports
    const stdioServers = mcpServers.filter((s) => s.transport === 'stdio');
    const httpServers = mcpServers.filter((s) => s.transport === 'http' || s.transport === 'sse');

    console.log(
      `   📊 [Codex MCP] Transport breakdown: ${stdioServers.length} STDIO, ${httpServers.length} HTTP/SSE`
    );

    // Create hash to detect changes
    // Include server config fields (not just IDs) so URL/command/auth changes trigger a rewrite
    const serverFingerprints = mcpServers
      .map(
        (s) =>
          `${s.mcp_server_id}:${s.transport}:${s.url || ''}:${s.command || ''}:${JSON.stringify(s.args || [])}:${s.auth?.token || ''}`
      )
      .sort();
    const configHash = `${approvalPolicy}:${networkAccess}:${mcpToken || ''}:${JSON.stringify(serverFingerprints)}`;

    // Skip if config and target directory haven't changed (avoid unnecessary file I/O)
    if (this.lastMCPServersHash === configHash && this.lastCodexHome === codexHome) {
      console.log(`✅ [Codex MCP] Config unchanged, skipping write`);
      return stdioServers.length + httpServers.length + (mcpToken ? 1 : 0);
    }

    const configPath = path.join(codexHome, 'config.toml');
    const metadataPath = path.join(codexHome, '.agor-managed.json');

    console.log(`📁 [Codex MCP] Using CODEX_HOME: ${codexHome}`);
    console.log(`📄 [Codex MCP] Updating config at: ${configPath}`);

    const isPlainObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);

    let existingConfig: JsonMap | undefined;
    let preservedHeader = '';

    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const headerMatch = raw.match(/^(?:\s*#.*\n)*/);
      preservedHeader = headerMatch?.[0] ?? '';
      existingConfig = parseToml(raw) as JsonMap;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`⚠️  [Codex MCP] Failed to read existing config.toml: ${String(error)}`);
      }
    }

    let previousManagedServers: string[] = [];
    try {
      const metadataRaw = await fs.readFile(metadataPath, 'utf-8');
      const parsed = JSON.parse(metadataRaw) as { mcpServers?: string[] };
      if (Array.isArray(parsed.mcpServers)) {
        previousManagedServers = parsed.mcpServers;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`⚠️  [Codex MCP] Failed to read managed metadata: ${String(error)}`);
      }
    }

    const configData: JsonMap = existingConfig ? { ...existingConfig } : {};

    configData.approval_policy = approvalPolicy;

    const sandboxConfig = isPlainObject(configData.sandbox_workspace_write)
      ? { ...(configData.sandbox_workspace_write as JsonMap) }
      : ({} as JsonMap);
    sandboxConfig.network_access = networkAccess;
    configData.sandbox_workspace_write = sandboxConfig;

    const existingMcpServersRaw = isPlainObject(configData.mcp_servers)
      ? (configData.mcp_servers as JsonMap)
      : undefined;
    const mcpServersConfig: JsonMap = existingMcpServersRaw ? { ...existingMcpServersRaw } : {};

    const managedServerNames = new Set<string>();

    // Configure built-in Agor MCP server (streamable HTTP)
    if (mcpToken) {
      const daemonUrl = await getDaemonUrl();
      const agorMcpUrl = `${daemonUrl}/mcp?sessionToken=${encodeURIComponent(mcpToken)}`;

      managedServerNames.add('agor');
      mcpServersConfig.agor = {
        url: agorMcpUrl,
        required: false,
      } as JsonMap;
      console.log(
        `   📝 [Codex MCP] Configuring built-in Agor MCP server (HTTP) at ${daemonUrl}/mcp`
      );
    }

    // Configure STDIO MCP servers
    for (const server of stdioServers) {
      let serverName = server.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      // Reserve 'agor' for the built-in Agor MCP server
      if (serverName === 'agor') {
        serverName = 'user_agor';
        console.warn(
          `   ⚠️  [Codex MCP] Server "${server.name}" conflicts with built-in Agor MCP server, renamed to "${serverName}"`
        );
      }
      managedServerNames.add(serverName);

      const serverConfig: JsonMap = {};
      console.log(`   📝 [Codex MCP] Configuring STDIO server: ${server.name} -> ${serverName}`);
      if (server.command) {
        serverConfig.command = server.command;
        console.log(`      command: ${server.command}`);
      }
      if (server.args && server.args.length > 0) {
        serverConfig.args = server.args;
        console.log(`      args: ${JSON.stringify(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        serverConfig.env = server.env;
        console.log(`      env vars: ${Object.keys(server.env).length} variable(s)`);
      }

      mcpServersConfig[serverName] = serverConfig;
    }

    // Configure HTTP/SSE MCP servers (streamable HTTP transport)
    for (const server of httpServers) {
      let serverName = server.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
      // Reserve 'agor' for the built-in Agor MCP server
      if (serverName === 'agor') {
        serverName = 'user_agor';
        console.warn(
          `   ⚠️  [Codex MCP] Server "${server.name}" conflicts with built-in Agor MCP server, renamed to "${serverName}"`
        );
      }
      managedServerNames.add(serverName);

      const serverConfig: JsonMap = {};
      console.log(`   📝 [Codex MCP] Configuring HTTP server: ${server.name} -> ${serverName}`);
      if (server.url) {
        serverConfig.url = server.url;
        console.log(`      url: ${server.url}`);
      }

      // Handle authentication for HTTP servers
      // Codex supports bearer_token_env_var, http_headers, and env_http_headers
      // Note: 'env' field is only valid for STDIO servers in Codex config.toml
      if (server.auth?.type === 'bearer' && server.auth.token) {
        // Inject resolved bearer token via a session-scoped env var
        // Include sessionId to avoid collisions between concurrent sessions
        const envVarName = `AGOR_MCP_${sessionId.substring(0, 8)}_${serverName.toUpperCase()}`;
        process.env[envVarName] = server.auth.token;
        serverConfig.bearer_token_env_var = envVarName;
        console.log(`      auth: bearer token via ${envVarName}`);
      }

      mcpServersConfig[serverName] = serverConfig;
    }

    const previousManagedSet = new Set(previousManagedServers);
    for (const serverName of previousManagedSet) {
      if (!managedServerNames.has(serverName)) {
        delete mcpServersConfig[serverName];
      }
    }

    if (Object.keys(mcpServersConfig).length > 0) {
      configData.mcp_servers = mcpServersConfig;
    } else {
      delete configData.mcp_servers;
    }

    let configBody = stringifyToml(configData);
    if (configBody && !configBody.endsWith('\n')) {
      configBody += '\n';
    }

    let header = preservedHeader;
    if (!header.trim()) {
      header = `# Codex configuration\n# Managed by Agor - ${new Date().toISOString()}\n\n`;
    } else if (!header.endsWith('\n\n')) {
      header = header.endsWith('\n') ? `${header}\n` : `${header}\n\n`;
    }

    await fs.writeFile(configPath, `${header}${configBody}`, 'utf-8');

    const managedServerList = Array.from(managedServerNames.values()).sort();

    await fs.writeFile(
      metadataPath,
      JSON.stringify({ mcpServers: managedServerList }, null, 2),
      'utf-8'
    );

    this.lastMCPServersHash = configHash;
    this.lastCodexHome = codexHome;
    console.log(
      `✅ [Codex] Updated config.toml with approval_policy = "${approvalPolicy}", network_access = ${networkAccess}`
    );

    // Reinitialize Codex SDK to pick up the new config
    this.reinitializeCodex();

    const totalConfigured = stdioServers.length + httpServers.length + (mcpToken ? 1 : 0);
    if (totalConfigured > 0) {
      const parts: string[] = [];
      if (mcpToken) parts.push('Agor (HTTP)');
      if (stdioServers.length > 0)
        parts.push(`${stdioServers.length} STDIO (${stdioServers.map((s) => s.name).join(', ')})`);
      if (httpServers.length > 0)
        parts.push(`${httpServers.length} HTTP (${httpServers.map((s) => s.name).join(', ')})`);
      console.log(
        `✅ [Codex MCP] Configured ${totalConfigured} MCP server(s): ${parts.join(', ')}`
      );
    }

    return totalConfigured;
  }

  /**
   * Convert Codex item to ToolUse format
   * Maps different Codex item types to Agor tool use schema
   */
  private itemToToolUse(
    item: ThreadItem,
    status: 'started' | 'completed'
  ): {
    id: string;
    name: string;
    input: Record<string, unknown>;
    output?: string;
    status?: string;
  } | null {
    switch (item.type) {
      case 'command_execution':
        return {
          id: item.id,
          name: 'Bash', // Normalized to PascalCase for consistency with Claude Code
          input: { command: item.command },
          ...(status === 'completed' && {
            output: item.aggregated_output || '',
            status: item.status,
          }),
        };
      case 'file_change':
        return {
          id: item.id,
          name: 'edit_files',
          input: {
            changes: item.changes || [],
          },
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      case 'mcp_tool_call':
        return {
          id: item.id,
          name: `${item.server}.${item.tool}`,
          input: {},
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      case 'web_search':
        return {
          id: item.id,
          name: 'web_search',
          input: { query: item.query },
        };
      case 'reasoning':
        // Don't emit tool use for reasoning (it's internal)
        return null;
      case 'todo_list':
        // Don't emit tool use for todo list (it's internal)
        return null;
      case 'agent_message':
        // Don't emit tool use for text messages
        return null;
      default:
        return null;
    }
  }

  /**
   * Execute prompt with streaming support
   *
   * Uses Codex SDK's runStreamed() method for real-time event streaming.
   * Yields partial text chunks and complete messages.
   *
   * @param sessionId - Agor session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @param abortController - Optional AbortController for cancellation support
   * @returns Async generator of streaming events
   */
  async *promptSessionStreaming(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode,
    abortController?: AbortController
  ): AsyncGenerator<CodexStreamEvent> {
    // Get session to check for existing thread ID and working directory
    const session = await this.sessionsRepo.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // NOTE: API key resolution is already handled by executeToolTask in base-executor
    // The API key was resolved via daemon service and passed to this constructor
    // Use the API key from constructor (this.apiKey)
    const currentApiKey = this.apiKey || '';

    // Only recreate Codex client if API key changed (prevents memory leak - issue #133)
    // This ensures hot-reload of credentials from Settings UI while avoiding process accumulation
    this.refreshClient(currentApiKey);

    console.log(`🔍 [Codex] Starting prompt execution for session ${sessionId.substring(0, 8)}`);
    console.log(`   Permission mode: ${permissionMode || 'not specified (will use default)'}`);
    console.log(`   Existing thread ID: ${session.sdk_session_id || 'none (will create new)'}`);

    // HYBRID APPROACH: Codex permissions require THREE settings:
    // 1. sandboxMode (via ThreadOptions) - controls WHERE you can write
    // 2. approval_policy (via config.toml) - controls WHETHER agent asks before executing
    // 3. network_access (via config.toml) - controls network connectivity

    // Read from session.permission_config.codex (dual config), fallback to defaults
    const codexConfig = session.permission_config?.codex;
    const sandboxMode = codexConfig?.sandboxMode || 'workspace-write';
    const approvalPolicy = codexConfig?.approvalPolicy || 'on-request';
    const networkAccess = codexConfig?.networkAccess ?? false; // Default: disabled

    console.log(
      `   Using Codex permissions: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}`
    );

    // Create per-session CODEX_HOME with Agor context (avoids race conditions!)
    // Returns temp directory path like /tmp/agor-codex-{sessionId}
    const sessionCodexHome = await this.ensureCodexSessionContext(sessionId);

    // Set CODEX_HOME for this session (Codex SDK will use it)
    process.env.CODEX_HOME = sessionCodexHome;

    // Set approval_policy, network_access, and MCP servers in config.toml
    // Also configures the built-in Agor MCP server (streamable HTTP) if MCP token is available
    const mcpToken = session.mcp_token;
    if (!mcpToken) {
      console.warn(
        `⚠️  No MCP token found for session ${sessionId.substring(0, 8)} - Agor MCP tools unavailable`
      );
    }

    const mcpServerCount = await this.ensureCodexConfig(
      approvalPolicy,
      networkAccess,
      sessionId,
      sessionCodexHome, // Pass per-session CODEX_HOME
      mcpToken // Pass MCP token for built-in Agor MCP server
    );

    console.log(
      `   Configured: sandboxMode=${sandboxMode}, approval_policy + ${mcpServerCount} MCP server(s) via config.toml`
    );

    // Fetch worktree to get working directory
    const worktree = this.worktreesRepo
      ? await this.worktreesRepo.findById(session.worktree_id)
      : null;
    if (!worktree) {
      throw new Error(`Worktree ${session.worktree_id} not found for session ${sessionId}`);
    }

    console.log(`   Working directory: ${worktree.path}`);

    // Build thread options with sandbox mode and worktree working directory
    const threadOptions = {
      workingDirectory: worktree.path,
      skipGitRepoCheck: false,
      sandboxMode,
    };

    // Check if MCP servers were added after session creation
    // Codex SDK locks in MCP configuration at thread creation time
    // If MCP servers were added later, we need to start fresh to pick them up
    let mcpServersAddedAfterCreation = false;
    if (this.sessionMCPServerRepo && session.sdk_session_id) {
      try {
        const sessionMCPServers = await this.sessionMCPServerRepo.listServersWithMetadata(
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
              `⚠️  [Codex MCP] Server "${sms.server.name}" was added ${minutesAfterReference} minute(s) after the session last updated`
            );
            break;
          }
        }
      } catch (error) {
        console.warn('⚠️  [Codex] Failed to check MCP server timestamps:', error);
      }
    }

    if (mcpServersAddedAfterCreation && session.sdk_session_id) {
      console.warn(
        `⚠️  [Codex MCP] MCP servers were added after the last SDK sync - current thread won't see them!`
      );
      console.warn(`   🔧 SOLUTION: Clearing sdk_session_id to force fresh thread start`);
      console.warn(
        `   Previous SDK thread: ${session.sdk_session_id.substring(0, 8)} (will be discarded)`
      );

      // Clear SDK session ID to force fresh start with new MCP config
      await this.sessionsRepo.update(sessionId, { sdk_session_id: undefined });
      // Update local session object to reflect the change
      session.sdk_session_id = undefined;
    }

    // Check if we need to update thread settings due to approval policy change
    const previousApprovalPolicy = session.permission_config?.codex?.approvalPolicy || 'on-request';
    const approvalPolicyChanged = approvalPolicy !== previousApprovalPolicy;

    // Start or resume thread
    let thread: Thread;
    if (session.sdk_session_id) {
      console.log(`🔄 [Codex] Resuming thread: ${session.sdk_session_id}`);

      thread = this.codex.resumeThread(session.sdk_session_id, threadOptions);

      // If approval policy changed, send slash command to update thread settings
      if (approvalPolicyChanged) {
        console.log(
          `⚙️  [Codex] Approval policy changed: ${previousApprovalPolicy} → ${approvalPolicy}`
        );
        console.log(`   Sending slash command to update thread settings...`);

        // Send /approvals command to change approval policy mid-conversation
        // Note: sandboxMode is already updated via ThreadOptions on resumeThread()
        const slashCommand = `/approvals ${approvalPolicy}`;
        console.log(`   Executing: ${slashCommand}`);

        try {
          // Send the slash command and consume the response
          await thread.run(slashCommand);
          console.log(`✅ [Codex] Thread settings updated successfully`);
        } catch (error) {
          console.error(`❌ [Codex] Failed to update thread settings:`, error);
          // Continue anyway - the user's prompt will still be sent
        }
      }
    } else {
      console.log(`🆕 [Codex] Creating new thread`);
      if (mcpServerCount > 0) {
        console.log(
          `✅ [Codex MCP] New thread will have ${mcpServerCount} MCP server(s) available from config.toml`
        );
      }
      thread = this.codex.startThread(threadOptions);
    }

    try {
      console.log(
        `▶️  [Codex] Running prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`
      );

      // NOTE: User environment variables are already in process.env
      // The daemon passes them when spawning the executor via createUserProcessEnvironment()
      // No need to query the database again here!

      // Clear any stale stop flag from previous executions
      // This prevents a stop request meant for a previous prompt from affecting this one
      if (this.stopRequested.has(sessionId)) {
        console.log(
          `⚠️  Clearing stale stop flag for session ${sessionId} before starting new prompt`
        );
        this.stopRequested.delete(sessionId);
      }

      // Use streaming API with abort signal for proper cancellation support
      // The signal is passed to Codex SDK which will throw AbortError when aborted
      console.log(`🎬 [Codex] Starting runStreamed() for session ${sessionId.substring(0, 8)}`);
      const turnOptions = abortController ? { signal: abortController.signal } : undefined;
      const { events } = await thread.runStreamed(prompt, turnOptions);
      console.log(`✅ [Codex] runStreamed() returned, starting event iteration`);

      const currentMessage: Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
      }> = [];
      let threadId = session.sdk_session_id || '';
      const resolvedModel: string | undefined = session.model_config?.model || undefined;
      let allToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      let eventCount = 0;

      for await (const event of events) {
        eventCount++;
        console.log(`📨 [Codex] Event ${eventCount}: ${event.type}`);

        // Check if stop was requested
        if (this.stopRequested.get(sessionId)) {
          console.log(`🛑 Stop requested for session ${sessionId}, breaking event loop`);
          this.stopRequested.delete(sessionId);
          // Yield stopped event so caller knows execution was stopped early
          yield {
            type: 'stopped',
            threadId: thread.id || undefined,
          };
          break;
        }

        switch (event.type) {
          case 'turn.started':
            allToolUses = []; // Reset tool uses for new turn
            break;

          case 'item.started':
            // Emit tool_start events for tool items
            if (event.item) {
              const toolUseStart = this.itemToToolUse(event.item, 'started');
              if (toolUseStart) {
                yield {
                  type: 'tool_start',
                  toolUse: toolUseStart,
                  threadId: thread.id || undefined,
                };
              }
            }
            break;

          case 'item.updated':
            // NOTE: Based on official OpenAI sample, item.updated is only emitted for todo_list items
            // agent_message, reasoning, command_execution, file_change only emit item.started/item.completed
            // We could handle todo_list progress here if needed in the future
            // For now, we ignore item.updated since we don't track todo lists
            break;

          case 'item.completed':
            // Collect completed items and emit tool_complete events
            if (event.item) {
              // Emit tool_complete for tool items
              const toolUseComplete = this.itemToToolUse(event.item, 'completed');
              if (toolUseComplete) {
                // Add to allToolUses for backward compatibility (tool_uses field)
                allToolUses.push({
                  id: toolUseComplete.id,
                  name: toolUseComplete.name,
                  input: toolUseComplete.input,
                });

                // Add tool_use block to content array (for UI rendering)
                currentMessage.push({
                  type: 'tool_use',
                  id: toolUseComplete.id,
                  name: toolUseComplete.name,
                  input: toolUseComplete.input,
                });

                // Add tool_result block if we have output OR status (for UI rendering)
                if (toolUseComplete.output !== undefined || toolUseComplete.status) {
                  const isError =
                    toolUseComplete.status === 'failed' || toolUseComplete.status === 'error';

                  // Build content: prefer output, fall back to status message
                  let content = toolUseComplete.output || '';
                  if (!content && toolUseComplete.status) {
                    content = `[${toolUseComplete.status}]`;
                  }

                  currentMessage.push({
                    type: 'tool_result',
                    tool_use_id: toolUseComplete.id,
                    content,
                    is_error: isError,
                  });
                }

                yield {
                  type: 'tool_complete',
                  toolUse: toolUseComplete,
                  threadId: thread.id || undefined,
                };
              }

              // Emit intermediate text messages immediately (instead of batching to turn end)
              // Codex can emit multiple agent_message items per turn, interleaved with tool calls.
              // Yielding them immediately gives a "chatty" UX where users see text as it arrives.
              if ('text' in event.item && event.item.type === 'agent_message') {
                const textContent = [{ type: 'text', text: event.item.text as string }];

                yield {
                  type: 'complete',
                  content: textContent,
                  threadId: thread.id || '',
                  resolvedModel: resolvedModel || DEFAULT_CODEX_MODEL,
                  // No usage data for intermediate messages - only final turn.completed has it
                };
              }
            }
            break;

          case 'turn.completed': {
            // Turn complete, emit final message
            threadId = thread.id || '';
            const mappedUsage = extractCodexTokenUsage((event as { usage?: unknown }).usage);

            // Yield complete message with all tool uses
            yield {
              type: 'complete',
              content: currentMessage,
              toolUses: allToolUses.length > 0 ? allToolUses : undefined,
              threadId,
              resolvedModel: resolvedModel || DEFAULT_CODEX_MODEL,
              usage: mappedUsage,
              rawSdkEvent: event, // Pass through the actual SDK event (UNMUTATED)
            };

            // Exit the event loop after turn completion
            // Codex SDK doesn't always close the stream properly, so we break manually
            return;
          }

          case 'turn.failed': {
            console.error('❌ Codex turn failed:', event.error);
            // Stringify error object for better user-facing error messages
            const errorMessage =
              typeof event.error === 'string' ? event.error : JSON.stringify(event.error, null, 2);
            throw new Error(`Codex execution failed: ${errorMessage}`);
          }

          default:
            // Ignore other event types silently
            break;
        }
      }
    } catch (error) {
      // Check if this is an AbortError from AbortController.abort()
      // This is EXPECTED during stop - the SDK throws AbortError when cancelled
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('abort'))
      ) {
        console.log(
          `🛑 [Stop] Codex query aborted for session ${sessionId.substring(0, 8)} - this is expected`
        );
        // Yield stopped event to signal execution was halted
        yield { type: 'stopped', threadId: thread.id || undefined };
        // Don't throw - this is a clean stop, not an error
        return;
      }

      console.error('❌ Codex streaming error:', error);
      throw error;
    }
  }

  /**
   * Execute prompt (non-streaming version)
   *
   * Collects all streaming events and returns complete result.
   *
   * @param sessionId - Agor session ID
   * @param prompt - User prompt
   * @param taskId - Optional task ID
   * @param permissionMode - Permission mode for tool execution ('ask' | 'auto' | 'allow-all')
   * @returns Complete prompt result
   */
  async promptSession(
    sessionId: SessionID,
    prompt: string,
    taskId?: TaskID,
    permissionMode?: PermissionMode
  ): Promise<CodexPromptResult> {
    // Note: promptSessionStreaming will handle per-user API key resolution and refreshClient()
    const messages: CodexPromptResult['messages'] = [];
    let threadId = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let tokenUsage: TokenUsage | undefined;
    let resolvedModel: string | undefined;

    for await (const event of this.promptSessionStreaming(
      sessionId,
      prompt,
      taskId,
      permissionMode
    )) {
      if (event.type === 'complete') {
        messages.push({
          content: event.content,
          toolUses: event.toolUses,
        });
        threadId = event.threadId;
        resolvedModel = event.resolvedModel || resolvedModel;
        if (event.usage) {
          tokenUsage = event.usage;
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
      }
      // Skip partial events in non-streaming mode
    }

    return {
      messages,
      inputTokens,
      outputTokens,
      threadId,
      tokenUsage,
      resolvedModel,
    };
  }

  /**
   * Stop currently executing task
   *
   * Primary cancellation is handled via AbortController.signal passed to runStreamed().
   * When the signal is aborted, the SDK throws AbortError which is caught and handled.
   *
   * This method sets a backup flag that is checked in the event loop (for cases where
   * AbortController may not immediately interrupt the SDK's async iteration).
   *
   * @param sessionId - Session identifier
   * @returns Success status
   */
  stopTask(sessionId: SessionID): { success: boolean; reason?: string } {
    // Set stop flag as backup mechanism
    // Primary cancellation happens via AbortController.signal passed to SDK
    this.stopRequested.set(sessionId, true);
    console.log(`🛑 Stop requested for Codex session ${sessionId}`);

    return { success: true };
  }

  /**
   * Clean up session resources (e.g., on session close)
   *
   * Removes per-session CODEX_HOME directory with AGENTS.md and config.toml
   */
  async closeSession(sessionId: SessionID): Promise<void> {
    // Clean up per-session CODEX_HOME directory
    const sessionCodexHome = path.join(os.tmpdir(), `agor-codex-${sessionId}`);
    try {
      await fs.rm(sessionCodexHome, { recursive: true, force: true });
      console.log(`🗑️  [Codex] Removed per-session CODEX_HOME for session ${sessionId}`);
    } catch (error) {
      // Directory may not exist if session never ran - that's ok
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`⚠️  Failed to remove per-session CODEX_HOME:`, error);
      }
    }

    // Clean up session-scoped MCP bearer token env vars
    const envPrefix = `AGOR_MCP_${sessionId.substring(0, 8)}_`;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(envPrefix)) {
        delete process.env[key];
      }
    }

    // Clean up stop flag
    this.stopRequested.delete(sessionId);
  }
}
