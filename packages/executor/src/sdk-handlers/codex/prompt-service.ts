/**
 * Codex Prompt Service
 *
 * Handles live execution of prompts against Codex sessions using OpenAI Codex SDK.
 * Wraps the @openai/codex-sdk for thread management and execution.
 *
 * Auth: passes apiKey through CodexOptions when set; otherwise the spawned
 * Codex CLI falls back to `$CODEX_HOME/auth.json` (ChatGPT subscription auth).
 * In subscription mode (`useNativeAuth=true && !apiKey`) we override `env` and
 * scrub `OPENAI_API_KEY` / `CODEX_API_KEY` from the spawn so the CLI is
 * forced down the auth.json path.
 *
 * Per-session config (Agor session-context as `model_instructions_file`,
 * MCP server registry) is passed via `CodexOptions.config`. We do NOT
 * override `$CODEX_HOME` — Codex CLI's default `~/.codex` is preserved
 * across all unix_user_modes (the daemon spawns the executor as the right
 * user already).
 *
 * IMPORTANT: this service caches the Codex SDK instance and only recreates
 * it when the relevant config (apiKey, baseUrl, useNativeAuth, MCP servers,
 * instructions file path) actually changes. This prevents a memory leak
 * where new Codex CLI processes would be spawned on every prompt execution
 * without cleanup. See issue #133.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Thread, ThreadItem } from '@agor/core/sdk';
import { Codex } from '@agor/core/sdk';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { resolveMCPAuthHeaders } from '@agor/core/tools/mcp/jwt-auth';
import type { EffortLevel } from '@agor/core/types';
import { getDefaultCodexPermissionConfig } from '@agor/core/utils/permission-mode-mapper';
import { getDaemonUrl } from '../../config.js';
import type {
  MCPServerRepository,
  MessagesRepository,
  RepoRepository,
  SessionMCPServerRepository,
  SessionRepository,
  UsersRepository,
  WorktreeRepository,
} from '../../db/feathers-repositories.js';
import type { TokenUsage } from '../../types/token-usage.js';
import type { PermissionMode, SessionID, TaskID, UserID } from '../../types.js';
import { getMcpServersForSession } from '../base/mcp-scoping.js';
import { forkCodexThreadViaAppServer } from './app-server-client.js';
import { DEFAULT_CODEX_MODEL } from './models.js';
import { extractCodexContextSnapshotFromEvent, extractCodexTokenUsage } from './usage.js';

/**
 * Map Agor's effort level (`low`/`medium`/`high`/`max`) to Codex SDK's
 * `ModelReasoningEffort` (`minimal`/`low`/`medium`/`high`/`xhigh`).
 *
 * Agor has no equivalent for `minimal`, and Codex has no equivalent for `max`
 * — `max` is the user's "go as deep as possible" intent, which on Codex maps
 * to `xhigh`.
 */
function toCodexReasoningEffort(
  effort: EffortLevel | undefined
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (!effort) return undefined;
  return effort === 'max' ? 'xhigh' : effort;
}

/**
 * Mirrors the (unexported) `CodexConfigObject` shape from `@openai/codex-sdk`.
 * The SDK flattens nested objects into `--config key.path=value` flags and
 * TOML-quotes string values automatically.
 */
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
interface CodexConfigObject {
  [key: string]: CodexConfigValue;
}

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
        output?: string | Array<Record<string, unknown>>;
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
      rawContextUsage?: {
        totalTokens: number;
        maxTokens: number;
        percentage: number;
      };
    };

export class CodexPromptService {
  private codex: InstanceType<typeof Codex.Codex>;
  private lastApiKey: string | null = null;
  private lastBaseUrl: string | null = null;
  private lastClientFingerprint: string | null = null;
  private stopRequested = new Map<SessionID, boolean>();
  private apiKey: string | undefined;
  private useNativeAuth: boolean;
  private instructionsFilePaths = new Map<SessionID, string>();

  /**
   * Resolve the per-user custom OpenAI-compatible base URL.
   *
   * Sourced from `process.env.OPENAI_BASE_URL`, which the daemon populates
   * from the user's `agentic_tools.codex.OPENAI_BASE_URL` setting via
   * `createUserProcessEnvironment` (see packages/core/src/config/env-resolver.ts).
   *
   * Empty / unset → returns undefined so the Codex SDK uses its default endpoint.
   * Logged at DEBUG only (could leak internal hostnames).
   */
  private resolveBaseUrl(): string | undefined {
    const raw = process.env.OPENAI_BASE_URL?.trim();
    return raw && raw.length > 0 ? raw : undefined;
  }

  constructor(
    _messagesRepo: MessagesRepository,
    private sessionsRepo: SessionRepository,
    private sessionMCPServerRepo?: SessionMCPServerRepository,
    private worktreesRepo?: WorktreeRepository,
    private reposRepo?: RepoRepository,
    apiKey?: string,
    private mcpServerRepo?: MCPServerRepository,
    private usersRepo?: UsersRepository,
    useNativeAuth: boolean = false
  ) {
    // Store API key from base-executor (already resolved with proper precedence)
    this.apiKey = apiKey || '';
    this.lastApiKey = this.apiKey;
    this.useNativeAuth = useNativeAuth;
    const baseUrl = this.resolveBaseUrl();
    this.lastBaseUrl = baseUrl ?? null;

    if (this.apiKey) {
      // Source already logged by base-executor via resolveApiKeyForTask().
    } else if (this.useNativeAuth) {
      console.log(
        '🔓 [Codex] No API key configured — falling back to ChatGPT subscription auth from $CODEX_HOME/auth.json. ' +
          'Run `codex login` if you have not authenticated yet.'
      );
    } else {
      console.error(
        '❌ [Codex] No API key and native auth disabled — Codex requests will fail with 401. ' +
          'Configure your API key in Settings > Codex > Authentication or sign in via `codex login`.'
      );
    }

    if (baseUrl) {
      console.debug(`🔗 [Codex] Using custom OPENAI_BASE_URL`);
    }

    // Bootstrap Codex SDK without per-session config (rebuilt lazily in
    // promptSessionStreaming once we know the session's instructions file +
    // MCP servers).
    this.codex = new Codex.Codex(this.buildCodexOptions(this.apiKey, baseUrl, undefined));
    this.lastClientFingerprint = null;

    // Best-effort sweep of orphaned per-session instructions files in
    // tmpdir. `closeSession()` removes a session's file when called, but
    // the daemon currently has no terminal-state hook that invokes it
    // (also true for Gemini/Copilot — broader gap). This sweep self-heals
    // long-running daemons that accumulate stale `agor-codex-instructions-*`
    // across crashes / unclean shutdowns / never-fired close hooks.
    void this.sweepStaleInstructionsFiles().catch((err) => {
      console.warn('⚠️  [Codex] Stale-instructions-file sweep failed:', err);
    });
  }

  /**
   * Delete `agor-codex-instructions-*.md` files in `os.tmpdir()` (and the
   * `~/.agor/tmp` fallback dir) older than 24h. Bounds the disk leak from
   * the missing close hook described in the constructor.
   */
  private async sweepStaleInstructionsFiles(): Promise<void> {
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const candidateDirs = [os.tmpdir(), path.join(os.homedir(), '.agor', 'tmp')];

    for (const dir of candidateDirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith('agor-codex-instructions-') || !name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoffMs) {
            await fs.unlink(full);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`⚠️  [Codex] Failed to sweep ${full}:`, err);
          }
        }
      }
    }
  }

  /**
   * Build CodexOptions for `new Codex({...})`.
   *
   * Subscription mode (no apiKey + useNativeAuth) scrubs `OPENAI_API_KEY` and
   * `CODEX_API_KEY` from the spawned Codex CLI process so it falls back to
   * `$CODEX_HOME/auth.json`. The SDK does NOT inherit `process.env` when an
   * `env` object is provided, so we forward all other vars explicitly.
   *
   * API-key mode omits `env` entirely so the SDK inherits `process.env`
   * normally and injects `CODEX_API_KEY` itself.
   */
  private buildCodexOptions(
    apiKey: string | undefined,
    baseUrl: string | undefined,
    config: CodexConfigObject | undefined
  ): ConstructorParameters<typeof Codex.Codex>[0] {
    const useSubscription = this.useNativeAuth && !apiKey;

    const options: ConstructorParameters<typeof Codex.Codex>[0] = {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(config ? { config } : {}),
    };

    if (useSubscription) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (k === 'OPENAI_API_KEY' || k === 'CODEX_API_KEY') continue;
        env[k] = v;
      }
      options.env = env;
    }

    return options;
  }

  /**
   * Refresh Codex client with latest API key from config (no per-session
   * config payload). Used at session start, before we have the instructions
   * file path or MCP servers — `ensureCodexClient()` is the per-turn refresh
   * that can change config.
   *
   * IMPORTANT: Only recreates Codex instance if API key OR base URL actually
   * changed. This prevents the issue #133 memory leak where unbounded Codex
   * CLI processes accumulate when we recreate without need.
   */
  private refreshClient(currentApiKey: string): void {
    const currentBaseUrl = this.resolveBaseUrl();
    const baseUrlChanged = (this.lastBaseUrl ?? null) !== (currentBaseUrl ?? null);
    if (this.lastApiKey !== currentApiKey || baseUrlChanged) {
      console.log(
        `🔄 [Codex] ${this.lastApiKey !== currentApiKey ? 'API key' : 'Base URL'} changed, reinitializing SDK...`
      );
      this.codex = new Codex.Codex(
        this.buildCodexOptions(currentApiKey, currentBaseUrl, undefined)
      );
      this.apiKey = currentApiKey;
      this.lastApiKey = currentApiKey;
      this.lastBaseUrl = currentBaseUrl ?? null;
      this.lastClientFingerprint = null;
      console.log('✅ [Codex] SDK reinitialized');
    }
  }

  /**
   * Snapshot the values of every `AGOR_MCP_*` env var (set by
   * `buildMcpServersConfig` for built-in + per-server bearer tokens). Folded
   * into the client fingerprint so a token rotation invalidates the cached
   * Codex instance even when the config object's shape (server names,
   * `bearer_token_env_var` keys) is unchanged.
   *
   * Without this, both subscription mode (where we pass `env` snapshot to
   * `CodexOptions.env`) and API-key mode (where the SDK snapshots
   * `process.env` at construction time) would keep spawning the cached Codex
   * with a stale token after rotation.
   */
  private snapshotMcpEnvValues(): Record<string, string> {
    const snapshot: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AGOR_MCP_')) {
        snapshot[key] = process.env[key] ?? '';
      }
    }
    return snapshot;
  }

  /**
   * Recreate `this.codex` with the per-session `config` payload (instructions
   * file + MCP servers) only when the fingerprint changed. Prevents per-turn
   * SDK churn (issue #133) while still reflecting fresh per-session config.
   *
   * The fingerprint includes a snapshot of `AGOR_MCP_*` env values so that
   * rotated MCP bearer tokens invalidate the cache even when the config
   * shape stays the same — see `snapshotMcpEnvValues()`.
   */
  private ensureCodexClient(config: CodexConfigObject): void {
    const baseUrl = this.resolveBaseUrl();
    const fingerprint = JSON.stringify({
      apiKey: this.apiKey || '',
      baseUrl: baseUrl ?? '',
      useNativeAuth: this.useNativeAuth,
      config,
      mcpEnv: this.snapshotMcpEnvValues(),
    });

    if (this.lastClientFingerprint === fingerprint) {
      return;
    }

    console.log(
      `🔄 [Codex] Per-session config changed, reinitializing SDK (apiKey=${this.apiKey ? 'set' : 'unset'}, useNativeAuth=${this.useNativeAuth})`
    );
    this.codex = new Codex.Codex(this.buildCodexOptions(this.apiKey, baseUrl, config));
    this.lastApiKey = this.apiKey || null;
    this.lastBaseUrl = baseUrl ?? null;
    this.lastClientFingerprint = fingerprint;
  }

  /**
   * Write the rendered Agor session-context prompt to a single file under
   * `os.tmpdir()` and return its absolute path.
   *
   * Replaces the per-session CODEX_HOME directory + AGENTS.md mechanism — we
   * now point Codex at this file via the `model_instructions_file` config key
   * (loaded by Codex CLI in addition to any project AGENTS.md files).
   *
   * `~/.codex/` is NEVER touched: the user's auth.json and any user-authored
   * config.toml stay where they are.
   */
  private async ensureCodexInstructionsFile(sessionId: SessionID): Promise<string> {
    const agorSystemPrompt = await renderAgorSystemPrompt(sessionId, {
      sessions: this.sessionsRepo,
      worktrees: this.worktreesRepo,
      repos: this.reposRepo,
      users: this.usersRepo,
    });

    const fileName = `agor-codex-instructions-${sessionId}.md`;

    // Try /tmp first; fall back to ~/.agor/tmp if /tmp is unavailable
    // (sandboxed executors / containers without /tmp).
    let filePath = path.join(os.tmpdir(), fileName);
    try {
      await fs.writeFile(filePath, agorSystemPrompt, { encoding: 'utf-8', mode: 0o600 });
    } catch (writeError) {
      const fallbackBase = path.join(os.homedir(), '.agor', 'tmp');
      console.warn(
        `⚠️  [Codex] Failed to write instructions file in ${os.tmpdir()} (${(writeError as Error).message}), falling back to ${fallbackBase}`
      );
      await fs.mkdir(fallbackBase, { recursive: true, mode: 0o700 });
      filePath = path.join(fallbackBase, fileName);
      await fs.writeFile(filePath, agorSystemPrompt, { encoding: 'utf-8', mode: 0o600 });
    }

    this.instructionsFilePaths.set(sessionId, filePath);
    console.log(`✅ [Codex] Wrote per-session instructions file at ${filePath}`);
    return filePath;
  }

  /**
   * Claim a unique sanitized server name within this session's mcp_servers
   * map. Sanitization collapses non-`[a-z0-9_-]` chars to `_`, so distinct
   * input names can collide (`Foo Bar` and `foo_bar` both become `foo_bar`)
   * — without de-collision the second would silently overwrite the first.
   *
   * On collision we suffix `_2`, `_3`, ... and warn so operators can spot
   * the underlying naming clash.
   */
  private claimMcpServerName(
    rawName: string,
    claimed: Set<string>,
    reservedReason?: string
  ): string {
    let base = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (reservedReason) {
      base = `user_${base}`;
      console.warn(
        `   ⚠️  [Codex MCP] "${rawName}" ${reservedReason}, renamed to "${base}" to disambiguate`
      );
    }
    if (!claimed.has(base)) {
      claimed.add(base);
      return base;
    }
    let suffix = 2;
    while (claimed.has(`${base}_${suffix}`)) suffix++;
    const final = `${base}_${suffix}`;
    console.warn(
      `   ⚠️  [Codex MCP] sanitized name "${base}" already claimed (raw="${rawName}"), using "${final}"`
    );
    claimed.add(final);
    return final;
  }

  /**
   * Build the `mcp_servers` nested config object for `CodexOptions.config`.
   *
   * Includes the built-in Agor MCP server (when `mcpToken` is provided) plus
   * all session-scoped + global MCP servers, categorized by transport. The
   * SDK's `flattenConfigOverrides` turns this object into repeated
   * `--config mcp_servers.<name>.<field>=<value>` flags for the Codex CLI.
   *
   * Bearer tokens (whether plain bearer, JWT, or OAuth) are resolved via the
   * shared `resolveMCPAuthHeaders` (matching Claude) and injected via env
   * vars referenced by `bearer_token_env_var` (never inlined in the URL).
   *
   * `forUserId` is required for per-user OAuth token injection at the
   * scoping layer — without it, OAuth-protected MCP servers won't pick up
   * the requesting user's stored OAuth tokens.
   */
  private async buildMcpServersConfig(
    sessionId: SessionID,
    mcpToken: string | undefined,
    forUserId: UserID | undefined
  ): Promise<{ servers: CodexConfigObject; total: number }> {
    console.log(`🔍 [Codex MCP] Fetching MCP servers for session ${sessionId.substring(0, 8)}...`);
    console.log(`   [Codex MCP] forUserId: ${forUserId || 'NOT SET'}`);

    const serversWithSource = await getMcpServersForSession(sessionId, {
      sessionMCPRepo: this.sessionMCPServerRepo,
      mcpServerRepo: this.mcpServerRepo,
      forUserId,
    });

    const mcpServers = serversWithSource.map((s) => s.server);

    console.log(`📊 [Codex MCP] Found ${mcpServers.length} MCP server(s) for session`);
    if (mcpServers.length > 0) {
      console.log(`   Servers: ${mcpServers.map((s) => `${s.name} (${s.transport})`).join(', ')}`);
    }

    const stdioServers = mcpServers.filter((s) => s.transport === 'stdio');
    const httpServers = mcpServers.filter((s) => s.transport === 'http' || s.transport === 'sse');

    console.log(
      `   📊 [Codex MCP] Transport breakdown: ${stdioServers.length} STDIO, ${httpServers.length} HTTP/SSE`
    );

    const result: CodexConfigObject = {};
    const claimedNames = new Set<string>();

    // Built-in Agor MCP server (streamable HTTP). Token travels via
    // bearer_token_env_var — never in the URL.
    if (mcpToken) {
      const daemonUrl = await getDaemonUrl();
      const agorBearerEnvVar = `AGOR_MCP_${sessionId.substring(0, 8)}_AGOR`;
      process.env[agorBearerEnvVar] = mcpToken;

      claimedNames.add('agor');
      result.agor = {
        url: `${daemonUrl}/mcp`,
        bearer_token_env_var: agorBearerEnvVar,
        required: false,
      };
      console.log(
        `   📝 [Codex MCP] Configuring built-in Agor MCP server (HTTP) at ${daemonUrl}/mcp`
      );
    }

    for (const server of stdioServers) {
      const serverName = this.claimMcpServerName(
        server.name,
        claimedNames,
        server.name.toLowerCase() === 'agor' ? 'conflicts with built-in Agor MCP server' : undefined
      );

      const serverConfig: CodexConfigObject = {};
      console.log(`   📝 [Codex MCP] Configuring STDIO server: ${server.name} -> ${serverName}`);
      if (server.command) {
        serverConfig.command = server.command;
        console.log(`      command: ${server.command}`);
      }
      if (server.args && server.args.length > 0) {
        serverConfig.args = server.args as CodexConfigValue[];
        console.log(`      args: ${JSON.stringify(server.args)}`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        serverConfig.env = server.env as CodexConfigObject;
        console.log(`      env vars: ${Object.keys(server.env).length} variable(s)`);
      }

      result[serverName] = serverConfig;
    }

    for (const server of httpServers) {
      const serverName = this.claimMcpServerName(
        server.name,
        claimedNames,
        server.name.toLowerCase() === 'agor' ? 'conflicts with built-in Agor MCP server' : undefined
      );

      const serverConfig: CodexConfigObject = {};
      console.log(`   📝 [Codex MCP] Configuring HTTP server: ${server.name} -> ${serverName}`);
      if (server.url) {
        serverConfig.url = server.url;
        console.log(`      url: ${server.url}`);
      }

      // Resolve the Authorization header via the shared MCP auth helper —
      // covers bearer / JWT (with token-mint) / OAuth (with cached & DB
      // tokens). Codex passes the bearer through `bearer_token_env_var`,
      // not a header map, so we extract the bearer token and route it via
      // an env var. Non-bearer schemes log a warning since Codex's CLI
      // only supports bearer auth.
      try {
        const headers = await resolveMCPAuthHeaders(server.auth, server.url);
        const authHeader = headers?.Authorization;
        if (authHeader) {
          const bearerToken = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1];
          if (bearerToken) {
            const envVarName = `AGOR_MCP_${sessionId.substring(0, 8)}_${serverName.toUpperCase()}`;
            process.env[envVarName] = bearerToken;
            serverConfig.bearer_token_env_var = envVarName;
            console.log(`      auth: ${server.auth?.type ?? 'bearer'} token via ${envVarName}`);
          } else {
            console.warn(
              `      ⚠️  auth: resolved Authorization header for "${server.name}" is not a Bearer scheme (Codex CLI only supports bearer); skipping injection`
            );
          }
        } else if (server.auth?.type === 'oauth') {
          console.warn(
            `   ⚠️  [Codex MCP] Server "${server.name}" requires OAuth but no valid token found.`
          );
          console.warn(
            `      💡 Go to Settings → MCP Servers → ${server.name} → Start OAuth Flow to authenticate.`
          );
        }
      } catch (error) {
        console.warn(
          `   ⚠️  [Codex MCP] Failed to resolve auth headers for "${server.name}":`,
          error instanceof Error ? error.message : String(error)
        );
      }

      result[serverName] = serverConfig;
    }

    const total = stdioServers.length + httpServers.length + (mcpToken ? 1 : 0);
    if (total > 0) {
      const parts: string[] = [];
      if (mcpToken) parts.push('Agor (HTTP)');
      if (stdioServers.length > 0)
        parts.push(`${stdioServers.length} STDIO (${stdioServers.map((s) => s.name).join(', ')})`);
      if (httpServers.length > 0)
        parts.push(`${httpServers.length} HTTP (${httpServers.map((s) => s.name).join(', ')})`);
      console.log(`✅ [Codex MCP] Configured ${total} MCP server(s): ${parts.join(', ')}`);
    }

    return { servers: result, total };
  }

  /**
   * Convert Codex todo_list items to TodoWrite-compatible payload.
   * Codex only provides completed:boolean, so we infer a single in_progress
   * item as the first remaining incomplete step for better UI parity.
   */
  private codexTodosToTodoWriteInput(
    items: Array<{ text: string; completed: boolean }>
  ): Record<string, unknown> | null {
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const firstIncompleteIndex = items.findIndex((todo) => !todo.completed);

    return {
      todos: items.map((todo, index) => ({
        content: todo.text,
        activeForm: todo.text,
        status: todo.completed
          ? 'completed'
          : firstIncompleteIndex === -1
            ? 'pending'
            : index === firstIncompleteIndex
              ? 'in_progress'
              : 'pending',
      })),
    };
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
    output?: string | Array<Record<string, unknown>>;
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
      case 'mcp_tool_call': {
        // Preserve MCP result/error payloads so the UI can render meaningful output.
        // This matches Claude's "start/end + payload" visibility model.
        let mcpOutput: string | Array<Record<string, unknown>> | undefined;
        if (status === 'completed') {
          if (Array.isArray(item.result?.content) && item.result.content.length > 0) {
            mcpOutput = item.result.content as Array<Record<string, unknown>>;
          } else if (item.result?.structured_content !== undefined) {
            mcpOutput = JSON.stringify(item.result.structured_content, null, 2);
          } else if (item.error?.message) {
            mcpOutput = item.error.message;
          }
        }
        return {
          id: item.id,
          name: `${item.server}.${item.tool}`,
          input:
            item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
              ? (item.arguments as Record<string, unknown>)
              : {},
          ...(mcpOutput !== undefined && {
            output: mcpOutput,
          }),
          ...(status === 'completed' && {
            status: item.status,
          }),
        };
      }
      case 'web_search':
        return {
          id: item.id,
          name: 'web_search',
          input: { query: item.query },
          ...(status === 'completed' && {
            // Emit a terminal marker so web_search doesn't remain stale in UI.
            status: 'completed',
          }),
        };
      case 'reasoning':
        // Don't emit tool use for reasoning (it's internal)
        return null;
      case 'todo_list': {
        const todoInput = this.codexTodosToTodoWriteInput(item.items);
        if (!todoInput) return null;
        return {
          id: item.id,
          name: 'TodoWrite',
          input: todoInput,
        };
      }
      case 'agent_message':
        // Don't emit tool use for text messages
        return null;
      default:
        return null;
    }
  }

  /**
   * Fork a Codex thread for an Agor forked session.
   *
   * The public TypeScript Codex SDK does not currently expose fork(), but the
   * local Codex App Server does expose `thread/fork`. Keep this as a tiny
   * sidecar: create the forked thread id, persist it to Agor, then continue
   * through the normal SDK `resumeThread(...).runStreamed(...)` path.
   */
  private async ensureForkedCodexThread(
    sessionId: SessionID,
    session: {
      genealogy?: { forked_from_session_id?: SessionID };
      sdk_session_id?: string | null;
    }
  ): Promise<void> {
    if (session.sdk_session_id) return;

    const parentSessionId = session.genealogy?.forked_from_session_id;
    if (!parentSessionId) return;

    const parentSession = await this.sessionsRepo.findById(parentSessionId);
    if (!parentSession?.sdk_session_id) {
      console.warn(
        `⚠️  [Codex] Fork requested from parent ${parentSessionId.substring(0, 8)}, but parent has no Codex thread id; starting fresh`
      );
      return;
    }

    console.log(
      `🍴 [Codex] Forking from parent thread ${parentSession.sdk_session_id.substring(0, 8)} via app-server thread/fork`
    );

    const appServerEnv: NodeJS.ProcessEnv = { ...process.env };
    if (this.useNativeAuth && !this.apiKey) {
      delete appServerEnv.OPENAI_API_KEY;
      delete appServerEnv.CODEX_API_KEY;
    } else if (this.apiKey) {
      appServerEnv.CODEX_API_KEY = this.apiKey;
    }

    const forkedThreadId = await forkCodexThreadViaAppServer(parentSession.sdk_session_id, {
      env: appServerEnv,
    });
    await this.sessionsRepo.update(sessionId, { sdk_session_id: forkedThreadId });
    session.sdk_session_id = forkedThreadId;

    console.log(
      `✅ [Codex] Forked thread ${parentSession.sdk_session_id.substring(0, 8)} → ${forkedThreadId.substring(0, 8)}`
    );
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

    // Codex permission settings split across two surfaces:
    // - sandboxMode, approvalPolicy, networkAccessEnabled: per-thread via ThreadOptions
    // - MCP servers + model_instructions_file: per-Codex-instance via CodexOptions.config
    // ThreadOptions are emitted AFTER `--config` flags, so for keys that overlap
    // (approval_policy, sandbox_workspace_write.network_access) ThreadOptions win.
    //
    // The daemon resolver (`resolvePermissionConfig`) always emits a full
    // codex sub-config for new sessions, so this fallback only fires for
    // legacy sessions in the DB with a partial / missing `permission_config`.
    // It delegates to `getDefaultCodexPermissionConfig` so we have one source
    // of truth for what "system default" means across daemon + executor.
    const codexConfig = session.permission_config?.codex;
    const defaults = getDefaultCodexPermissionConfig();
    const sandboxMode = codexConfig?.sandboxMode ?? defaults.sandboxMode;
    const approvalPolicy = codexConfig?.approvalPolicy ?? defaults.approvalPolicy;
    const networkAccess = codexConfig?.networkAccess ?? defaults.networkAccess;

    console.log(
      `   Using Codex permissions: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}`
    );

    // Write per-session Agor instructions file (single .md, not a directory).
    // CODEX_HOME is intentionally NOT overridden — Codex CLI uses the
    // executor user's $HOME/.codex which already contains auth.json plus any
    // user-authored config.toml.
    const instructionsFile = await this.ensureCodexInstructionsFile(sessionId);

    const mcpToken = session.mcp_token;
    if (!mcpToken) {
      console.warn(
        `⚠️  No MCP token found for session ${sessionId.substring(0, 8)} - Agor MCP tools unavailable`
      );
    }

    // forUserId enables per-user OAuth token injection at the MCP scoping
    // layer — mirrors Claude's contextUserId pattern so personal OAuth-
    // protected MCP servers work for Codex too.
    const forUserId = (session.created_by ?? undefined) as UserID | undefined;
    const { servers: mcpServersConfig, total: mcpServerCount } = await this.buildMcpServersConfig(
      sessionId,
      mcpToken,
      forUserId
    );

    const codexConfigPayload: CodexConfigObject = {
      model_instructions_file: instructionsFile,
      ...(Object.keys(mcpServersConfig).length > 0 ? { mcp_servers: mcpServersConfig } : {}),
    };

    // Recreate Codex instance only if the per-session config payload (or
    // apiKey/baseUrl) actually changed — issue #133 protection.
    this.ensureCodexClient(codexConfigPayload);

    console.log(
      `   Configured: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}, ${mcpServerCount} MCP server(s)`
    );

    // Fetch worktree to get working directory
    const worktree = this.worktreesRepo
      ? await this.worktreesRepo.findById(session.worktree_id)
      : null;
    if (!worktree) {
      throw new Error(`Worktree ${session.worktree_id} not found for session ${sessionId}`);
    }

    console.log(`   Working directory: ${worktree.path}`);

    await this.ensureForkedCodexThread(sessionId, session);

    // Build thread options. approvalPolicy + networkAccessEnabled flow through
    // here (not config.toml); ThreadOptions override matching `--config` keys.
    // model + modelReasoningEffort are passed through from session.model_config
    // so the UI's per-session model picker actually controls what Codex runs.
    const sessionModel = session.model_config?.model;
    const sessionEffort = toCodexReasoningEffort(session.model_config?.effort);
    const threadOptions = {
      workingDirectory: worktree.path,
      skipGitRepoCheck: false,
      sandboxMode,
      approvalPolicy,
      networkAccessEnabled: networkAccess,
      ...(sessionModel ? { model: sessionModel } : {}),
      ...(sessionEffort ? { modelReasoningEffort: sessionEffort } : {}),
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
          `✅ [Codex MCP] New thread will have ${mcpServerCount} MCP server(s) available via --config flags`
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
        content?: string | Array<Record<string, unknown>>;
        is_error?: boolean;
      }> = [];
      let threadId = session.sdk_session_id || '';
      const resolvedModel: string | undefined = session.model_config?.model || undefined;
      let allToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
      let todoIdsEmittedViaUpdate = new Set<string>();
      let latestContextUsage:
        | {
            totalTokens: number;
            maxTokens: number;
            percentage: number;
          }
        | undefined;

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

        if ((event as { type?: string }).type === 'event_msg') {
          // Codex emits token_count as generic event_msg payloads.
          // Capture the latest snapshot so turn.completed can return context usage.
          const contextSnapshot = extractCodexContextSnapshotFromEvent(event);
          if (contextSnapshot) {
            latestContextUsage = contextSnapshot;
          }
          continue;
        }

        switch (event.type) {
          case 'turn.started':
            allToolUses = []; // Reset tool uses for new turn
            todoIdsEmittedViaUpdate = new Set<string>();
            latestContextUsage = undefined;
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
            // Codex emits item.updated for todo_list progress updates.
            // Normalize these into TodoWrite-style tool events so the UI can
            // reuse the same sticky todo rendering as Claude Code.
            if (event.item) {
              const toolUseUpdate = this.itemToToolUse(event.item, 'completed');
              if (toolUseUpdate?.name === 'TodoWrite') {
                todoIdsEmittedViaUpdate.add(toolUseUpdate.id);
                yield {
                  type: 'tool_complete',
                  toolUse: toolUseUpdate,
                  threadId: thread.id || undefined,
                };
              }
            }
            break;

          case 'item.completed':
            // Collect completed items and emit tool_complete events
            if (event.item) {
              // Emit tool_complete for tool items
              const toolUseComplete = this.itemToToolUse(event.item, 'completed');
              if (toolUseComplete) {
                const isDuplicateTodoCompletion =
                  event.item.type === 'todo_list' &&
                  todoIdsEmittedViaUpdate.has(toolUseComplete.id);

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

                if (!isDuplicateTodoCompletion) {
                  yield {
                    type: 'tool_complete',
                    toolUse: toolUseComplete,
                    threadId: thread.id || undefined,
                  };
                }
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

              // Surface reasoning as thinking blocks (non-streaming) so Codex reuses
              // the same ThinkingBlock UI used by Claude/OpenCode.
              if ('text' in event.item && event.item.type === 'reasoning') {
                const thinkingContent = [{ type: 'thinking', text: event.item.text as string }];
                yield {
                  type: 'complete',
                  content: thinkingContent,
                  threadId: thread.id || '',
                  resolvedModel: resolvedModel || DEFAULT_CODEX_MODEL,
                };
              }

              // Surface non-fatal item-level errors as assistant text so users can see
              // what happened instead of dropping them silently.
              if ('message' in event.item && event.item.type === 'error') {
                const errorContent = [
                  { type: 'text', text: `[Codex item error] ${event.item.message}` },
                ];
                yield {
                  type: 'complete',
                  content: errorContent,
                  threadId: thread.id || '',
                  resolvedModel: resolvedModel || DEFAULT_CODEX_MODEL,
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
              rawContextUsage: latestContextUsage,
            };

            // Exit the event loop after turn completion
            // Codex SDK doesn't always close the stream properly, so we break manually
            return;
          }

          case 'turn.failed': {
            // Classify error for better user-facing messages
            const errorMessage =
              typeof event.error === 'string' ? event.error : JSON.stringify(event.error, null, 2);

            // Detect 401/auth errors and provide actionable guidance
            if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
              const hasApiKey = !!this.apiKey;
              const guidance = hasApiKey
                ? 'Your OPENAI_API_KEY may be invalid or expired. Check Settings > Codex > Authentication, or run `codex login` for ChatGPT subscription auth.'
                : this.useNativeAuth
                  ? 'No API key configured and ChatGPT subscription auth (~/.codex/auth.json) was rejected or missing. Run `codex login` from the worktree terminal, or add an API key in Settings > Codex > Authentication.'
                  : 'No API key configured. Add one in Settings > Codex > Authentication, or sign in via `codex login`.';
              console.error(
                `❌ [Codex] Authentication failed for session ${sessionId.substring(0, 8)}: ${guidance}`
              );
              throw new Error(`Codex authentication failed: ${guidance}`);
            }

            // Log full error details for non-auth failures
            console.error(
              `❌ [Codex] Turn failed for session ${sessionId.substring(0, 8)}:`,
              errorMessage
            );
            throw new Error(`Codex execution failed: ${errorMessage}`);
          }

          case 'error':
            // Fatal stream-level error from Codex SDK.
            // Surface this as a task failure so users see it in the conversation.
            throw new Error(
              `Codex stream error: ${
                (event as { message?: unknown; error?: unknown }).message ||
                (event as { message?: unknown; error?: unknown }).error ||
                'unknown'
              }`
            );

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

      // Don't log here — error will be logged by the caller (base-executor)
      // to avoid duplicate error output in daemon logs
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
   * Best-effort removal of the per-session instructions file. Both possible
   * paths (os.tmpdir + ~/.agor/tmp fallback) are attempted in case the
   * tmpdir base differs from the one we wrote to.
   *
   * NOTE: as of writing, no daemon code path actually invokes
   * `closeSession()` for any tool (Codex/Gemini/Copilot all expose it; none
   * are wired to a terminal-state hook). The constructor's
   * `sweepStaleInstructionsFiles()` self-heals leaked files so this isn't
   * load-bearing today — but the method stays in place so the fix becomes
   * a one-line wire-up the day a real lifecycle hook lands.
   */
  async closeSession(sessionId: SessionID): Promise<void> {
    const fileName = `agor-codex-instructions-${sessionId}.md`;
    const recordedPath = this.instructionsFilePaths.get(sessionId);
    const candidatePaths = new Set<string>([
      ...(recordedPath ? [recordedPath] : []),
      path.join(os.tmpdir(), fileName),
      path.join(os.homedir(), '.agor', 'tmp', fileName),
    ]);

    for (const filePath of candidatePaths) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`⚠️  Failed to remove Codex instructions file at ${filePath}:`, error);
        }
      }
    }
    this.instructionsFilePaths.delete(sessionId);

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
