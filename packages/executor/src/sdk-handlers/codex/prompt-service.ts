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
import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';
import { shortId } from '@agor/core/db';
import {
  getMcpServersForSession,
  isMCPAbortError,
  listMcpToolsWithPermission,
  MCPExternalError,
  PERMISSIONS_BLOCKED_WITHOUT_PROMPT,
  resolveScopedMCPAuthHeaders,
  sanitizeMCPExternalError,
} from '@agor/core/mcp';
import type { CodexOptions, Thread, ThreadItem, TurnCompletedEvent } from '@agor/core/sdk';
import { renderAgorSystemPrompt } from '@agor/core/templates/session-context';
import { mergeMCPRemoteHeaders } from '@agor/core/tools/mcp/http-headers';
import type { CodexSandboxMode, ContextUsageSnapshot, MCPServer, Session } from '@agor/core/types';
import { getDefaultPermissionMode, isGatewaySession } from '@agor/core/types';
import { mapToCodexPermissionConfig } from '@agor/core/utils/permission-mode-mapper';
import type * as CodexSdk from '@openai/codex-sdk';
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
import { McpAuthDiagnosticAccumulator } from '../../diagnostics/mcp-auth-diagnostic-accumulator.js';
import { reportSdkActivity, type SdkActivityCallback } from '../../sdk-watchdog.js';
import type { TokenUsage } from '../../types/token-usage.js';
import type { PermissionMode, SessionID, TaskID, UserID } from '../../types.js';
import { resolveContextUserId } from '../base/context-user.js';
import type { TasksService } from '../base/index.js';
import { forkCodexThreadViaAppServer, listCodexSkillsViaAppServer } from './app-server-client.js';
import { applyAgorCodexLaunchPolicy } from './launch-policy.js';
import { extractCodexContextSnapshotFromEvent, extractCodexTokenUsage } from './usage.js';

type CodexSdkReasoningEffort = NonNullable<
  NonNullable<
    Parameters<InstanceType<typeof CodexSdk.Codex>['startThread']>[0]
  >['modelReasoningEffort']
>;

/**
 * Codex CLI config payload, sourced from the SDK's public `CodexOptions`
 * surface so we follow the SDK automatically. The SDK flattens nested
 * objects into `--config key.path=value` flags and TOML-quotes string
 * values for us.
 */
type CodexConfigObject = NonNullable<CodexOptions['config']>;
type CodexConfigValue = CodexConfigObject[string];

/**
 * Per-MCP-server config snippet that auto-approves all tool calls without
 * a user prompt. Codex's MCP elicitation gates tool calls behind a per-
 * server prompt that defaults to `Prompt`; in headless `exec --json`
 * (what `@openai/codex-sdk` uses), prompts resolve to "user cancelled
 * MCP tool call". Setting `default_tools_approval_mode = "approve"`
 * short-circuits that prompt and matches Agor's "trust the branch
 * sandbox, don't gate every MCP self-call" model. See
 * `codex-rs/codex-mcp/src/mcp/mod.rs::mcp_permission_prompt_is_auto_approved`
 * — without this, only `danger-full-access` (which grants full-disk-write)
 * clears the prompt.
 */
const MCP_AUTO_APPROVE: CodexConfigObject = { default_tools_approval_mode: 'approve' };

/**
 * Apply the server's `tool_permissions` to its Codex config.
 *
 * Codex's approval mode is per-server, not per-tool, so a gated tool cannot be
 * singled out for a prompt — and `exec --json` has no channel to prompt on
 * anyway (see `MCP_AUTO_APPROVE`). `disabled_tools` is the only per-tool lever
 * Codex exposes, so both `deny` and `ask` fail closed there; `allow` and
 * unlisted tools keep the server-wide auto-approve.
 */
function applyMcpToolPermissions(config: CodexConfigObject, server: MCPServer): void {
  const blocked = listMcpToolsWithPermission(server, PERMISSIONS_BLOCKED_WITHOUT_PROMPT);
  if (blocked.length === 0) return;

  config.disabled_tools = blocked as CodexConfigValue[];

  const asked = listMcpToolsWithPermission(server, ['ask']);
  console.warn(
    `   ⛔ [Codex MCP] Disabling ${blocked.length} tool(s) on "${server.name}" per tool_permissions` +
      (asked.length > 0
        ? ` (${asked.length} set to "ask"; Codex runs headless with no approval prompt, so they fail closed)`
        : '')
  );
}
const GATEWAY_MCP_STARTUP_TIMEOUT_MS = 30_000;

type CodexLifecycleFailureCode =
  | 'authentication_required'
  | 'completed_without_response'
  | 'turn_failed'
  | 'stream_start_failed'
  | 'stream_interrupted'
  | 'stream_ended_without_completion';

const CODEX_LIFECYCLE_MESSAGES: Record<CodexLifecycleFailureCode, string> = {
  authentication_required:
    'Codex authentication is not configured. Review Codex authentication settings and retry the prompt.',
  completed_without_response:
    'Codex completed after a stream error but returned no assistant response. Retry the prompt.',
  turn_failed:
    'Codex failed the turn. Retry the prompt; review Codex authentication or runtime status if it continues.',
  stream_start_failed: 'Codex could not start the turn. Retry the prompt.',
  stream_interrupted: 'The Codex turn was interrupted before completion. Retry the prompt.',
  stream_ended_without_completion:
    'Codex ended the turn without a completion event. Retry the prompt; restart the session if it continues.',
};

function projectCodexCompletedEvent(
  event: TurnCompletedEvent
): import('../../types/sdk-response').CodexSdkResponse {
  // The SDK object is an external runtime value even though its declared type
  // is closed. Project the documented accounting fields so extension metadata
  // (including exception objects) cannot reach Task persistence or realtime.
  let usage: unknown;
  try {
    usage = Reflect.get(event, 'usage');
  } catch {
    usage = undefined;
  }
  const count = (field: string): number => {
    if (!usage || typeof usage !== 'object') return 0;
    try {
      const value = Reflect.get(usage, field);
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  return {
    type: 'turn.completed',
    usage: {
      input_tokens: count('input_tokens'),
      cached_input_tokens: count('cached_input_tokens'),
      output_tokens: count('output_tokens'),
      reasoning_output_tokens: count('reasoning_output_tokens'),
    },
  };
}

class CodexLifecycleError extends Error {
  readonly failureCode: CodexLifecycleFailureCode;

  constructor(failureCode: CodexLifecycleFailureCode) {
    super(CODEX_LIFECYCLE_MESSAGES[failureCode]);
    this.name = 'CodexLifecycleError';
    this.failureCode = failureCode;
  }
}

function isKnownCodexBoundaryError(
  error: unknown
): error is CodexLifecycleError | MCPExternalError {
  try {
    return error instanceof CodexLifecycleError || error instanceof MCPExternalError;
  } catch {
    return false;
  }
}

function logCodexRuntimeFailure(
  event: 'stream_error_observed' | 'turn_completed_without_response' | 'turn_failed',
  error: unknown,
  sessionId: SessionID,
  category?: 'configuration_required'
): void {
  const safe = sanitizeMCPExternalError(error, {
    stage: 'runtime',
    ...(category ? { category } : {}),
  });
  const code = safe.diagnostic.code;
  const message = `[codex.runtime] event=${event} session_id=${sessionId} category=${safe.category} type=${safe.diagnostic.type}${code ? ` code=${code}` : ''}`;
  if (event === 'stream_error_observed') {
    console.warn(`${message} outcome=awaiting_terminal_event`);
  } else {
    console.error(message);
  }
}

function codexDebug(...args: unknown[]): void {
  if (process.env.AGOR_DEBUG_CODEX === '1' || process.env.DEBUG?.includes('codex')) {
    console.debug(...args);
  }
}

/**
 * Minimum gap between `skills/list` sidecar spawns for one session. Skill
 * installs are rare relative to prompts, so a short TTL keeps the composer's
 * autocomplete fresh without paying an app-server spawn on every turn.
 */
const SKILLS_DISCOVERY_TTL_MS = 5 * 60 * 1000;

interface CodexSkillsDiscoveryMetadata {
  session_id: SessionID;
  cwd: string;
  refreshed_at_ms: number;
}

function parseCodexSkillsDiscoveryMetadata(value: unknown): CodexSkillsDiscoveryMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.session_id !== 'string' ||
    typeof candidate.cwd !== 'string' ||
    typeof candidate.refreshed_at_ms !== 'number' ||
    !Number.isFinite(candidate.refreshed_at_ms)
  ) {
    return null;
  }
  return {
    session_id: candidate.session_id as SessionID,
    cwd: candidate.cwd,
    refreshed_at_ms: candidate.refreshed_at_ms,
  };
}

function applyGatewayMcpStartupGuard(config: CodexConfigObject, requireMcpServers: boolean): void {
  if (!requireMcpServers) return;
  config.required = true;
  config.startup_timeout_ms = GATEWAY_MCP_STARTUP_TIMEOUT_MS;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

async function findCodexRolloutFile(threadId: string): Promise<string | undefined> {
  if (!threadId) return undefined;

  const sessionsDir = path.join(getCodexHome(), 'sessions');

  async function walk(dir: string): Promise<string | undefined> {
    let entries: Array<import('node:fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = await walk(fullPath);
        if (found) return found;
      }
    }

    return undefined;
  }

  return walk(sessionsDir);
}

async function extractLatestContextUsageFromRollout(
  threadId: string
): Promise<ContextUsageSnapshot | undefined> {
  const rolloutPath = await findCodexRolloutFile(threadId);
  if (!rolloutPath) return undefined;

  let contents: string;
  try {
    contents = await fs.readFile(rolloutPath, 'utf8');
  } catch {
    return undefined;
  }

  let latest: ContextUsageSnapshot | undefined;
  for (const line of contents.split('\n')) {
    if (!line.includes('token_count')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      latest = extractCodexContextSnapshotFromEvent(parsed) ?? latest;
    } catch {
      // Ignore malformed / partially-written JSONL lines.
    }
  }

  return latest;
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
      rawContextUsage?: ContextUsageSnapshot;
    };

export class CodexPromptService {
  private codex?: InstanceType<typeof CodexSdk.Codex>;
  private lastApiKey: string | null = null;
  private lastBaseUrl: string | null = null;
  private lastClientFingerprint: string | null = null;
  private stopRequested = new Map<SessionID, boolean>();
  private apiKey: string | undefined;
  private useNativeAuth: boolean;
  private instructionsFilePaths = new Map<SessionID, string>();
  private skillsDiscovery = new Map<
    SessionID,
    { at: number; cwd: string; inFlight?: Promise<void> }
  >();

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
    private branchesRepo?: BranchRepository,
    _reposRepo?: RepoRepository,
    apiKey?: string,
    private mcpServerRepo?: MCPServerRepository,
    _usersRepo?: UsersRepository,
    useNativeAuth: boolean = false,
    private tasksService?: TasksService,
    private mcpOAuthAuthHeadersRepo?: MCPOAuthAuthHeadersRepository
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
      codexDebug(
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
      codexDebug(`🔗 [Codex] Using custom OPENAI_BASE_URL`);
    }

    // Do not construct the Codex SDK client until promptSessionStreaming has
    // resolved the session-scoped config (instructions file + MCP servers).
    // Constructing here with no MCP config and then replacing it moments later
    // makes the SDK/app-server briefly start with the wrong lifecycle, which is
    // visible as MCP disconnect/reconnect waves in gateway-driven turns.
    this.lastClientFingerprint = null;

    // Best-effort sweep of orphaned per-session instructions files in
    // tmpdir. `closeSession()` removes a session's file when called, but
    // the daemon currently has no terminal-state hook that invokes it
    // (also true for Gemini/Copilot — broader gap). This sweep self-heals
    // long-running daemons that accumulate stale `agor-codex-instructions-*`
    // across crashes / unclean shutdowns / never-fired close hooks.
    void this.sweepStaleInstructionsFiles().catch(() => {
      console.warn('⚠️  [Codex] Stale-instructions-file sweep failed');
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
      let deleted = 0;
      let failed = 0;
      const failedByCode = new Map<string, number>();
      for (const name of entries) {
        if (!name.startsWith('agor-codex-instructions-') || !name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoffMs) {
            await fs.unlink(full);
            deleted++;
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT') {
            failed++;
            failedByCode.set(code ?? 'UNKNOWN', (failedByCode.get(code ?? 'UNKNOWN') ?? 0) + 1);
          }
        }
      }
      if (deleted > 0) {
        codexDebug(`🧹 [Codex] Swept ${deleted} stale instructions file(s) from ${dir}`);
      }
      if (failed > 0) {
        const summary = [...failedByCode.entries()]
          .map(([code, count]) => `${code}=${count}`)
          .join(', ');
        codexDebug(
          `🧹 [Codex] Skipped ${failed} stale instructions file(s) in ${dir} (${summary})`
        );
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
   * normally and injects `CODEX_API_KEY` itself. Agor's product policy is
   * applied here, at the one SDK launch boundary shared by every Codex
   * executor topology.
   */
  private buildCodexOptions(
    apiKey: string | undefined,
    baseUrl: string | undefined,
    config: CodexConfigObject | undefined
  ): ConstructorParameters<typeof CodexSdk.Codex>[0] {
    const useSubscription = this.useNativeAuth && !apiKey;

    const options: ConstructorParameters<typeof CodexSdk.Codex>[0] = {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      config: applyAgorCodexLaunchPolicy(config),
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
        `🔄 [Codex] ${this.lastApiKey !== currentApiKey ? 'API key' : 'Base URL'} changed, invalidating SDK client...`
      );
      this.apiKey = currentApiKey;
      this.lastApiKey = currentApiKey;
      this.lastBaseUrl = currentBaseUrl ?? null;
      this.lastClientFingerprint = null;
      console.log('✅ [Codex] SDK configuration invalidated');
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
  private async ensureCodexClient(config: CodexConfigObject): Promise<void> {
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

    codexDebug(
      `🔄 [Codex] Per-session config changed, reinitializing SDK (apiKey=${this.apiKey ? 'set' : 'unset'}, useNativeAuth=${this.useNativeAuth})`
    );
    await this.replaceCodexClient(this.buildCodexOptions(this.apiKey, baseUrl, config));
    this.lastApiKey = this.apiKey || null;
    this.lastBaseUrl = baseUrl ?? null;
    this.lastClientFingerprint = fingerprint;
  }

  /**
   * Best-effort close for SDK clients that expose a lifecycle method. The
   * current Codex SDK API has changed over time, so probe common method names
   * rather than depending on one concrete type. Awaiting close before replacement
   * keeps abandoned app-server/MCP transports from overlapping the new client.
   */
  private async closeCodexClient(
    client: InstanceType<typeof CodexSdk.Codex> | undefined
  ): Promise<void> {
    if (!client) return;
    const candidate = client as unknown as {
      close?: () => void | Promise<void>;
      dispose?: () => void | Promise<void>;
      shutdown?: () => void | Promise<void>;
    };
    const close = candidate.close ?? candidate.dispose ?? candidate.shutdown;
    if (!close) return;

    try {
      await Promise.resolve(close.call(candidate));
    } catch (error) {
      const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
      console.warn(
        `⚠️  [Codex] Failed to close previous SDK client category=${safe.category} type=${safe.diagnostic.type}`
      );
    }
  }

  private async replaceCodexClient(
    options: ConstructorParameters<typeof CodexSdk.Codex>[0]
  ): Promise<void> {
    const previous = this.codex;
    this.codex = undefined;
    await this.closeCodexClient(previous);
    const Codex = await loadManagedAgenticToolSdk<typeof CodexSdk>('codex');
    this.codex = new Codex.Codex(options);
  }

  private getCodexClient(): InstanceType<typeof CodexSdk.Codex> {
    if (!this.codex) {
      throw new Error('Codex SDK client was not initialized before use');
    }
    return this.codex;
  }

  /**
   * Write the rendered static Agor orientation prompt to a single file under
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
    const agorSystemPrompt = await renderAgorSystemPrompt();

    const fileName = `agor-codex-instructions-${sessionId}.md`;

    // Try /tmp first; fall back to ~/.agor/tmp if /tmp is unavailable
    // (sandboxed executors / containers without /tmp).
    let filePath = path.join(os.tmpdir(), fileName);
    try {
      await fs.writeFile(filePath, agorSystemPrompt, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      const fallbackBase = path.join(os.homedir(), '.agor', 'tmp');
      console.warn('⚠️  [Codex] Primary instructions-file write failed; using fallback storage');
      await fs.mkdir(fallbackBase, { recursive: true, mode: 0o700 });
      filePath = path.join(fallbackBase, fileName);
      await fs.writeFile(filePath, agorSystemPrompt, { encoding: 'utf-8', mode: 0o600 });
    }

    this.instructionsFilePaths.set(sessionId, filePath);
    codexDebug(`✅ [Codex] Wrote per-session instructions file at ${filePath}`);
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
    context: {
      forUserId?: UserID;
      requireMcpServers?: boolean;
    }
  ): Promise<{ servers: CodexConfigObject; total: number }> {
    const { forUserId, requireMcpServers = false } = context;
    codexDebug(`🔍 [Codex MCP] Fetching MCP servers for session ${shortId(sessionId)}...`);
    codexDebug(`   [Codex MCP] forUserId: ${forUserId || 'NOT SET'}`);

    const serversWithSource = await getMcpServersForSession(
      sessionId,
      {
        sessionMCPRepo: this.sessionMCPServerRepo,
        mcpServerRepo: this.mcpServerRepo,
        mcpOAuthAuthHeadersRepo: this.mcpOAuthAuthHeadersRepo,
        forUserId,
      },
      { toolFiltering: 'exclude' }
    );

    const mcpServers = serversWithSource.map((s) => s.server);

    codexDebug(`📊 [Codex MCP] Found ${mcpServers.length} MCP server(s) for session`);
    if (mcpServers.length > 0) {
      codexDebug(`   Servers: ${mcpServers.map((s) => `${s.name} (${s.transport})`).join(', ')}`);
    }

    const stdioServers = serversWithSource.filter(({ server }) => server.transport === 'stdio');
    const httpServers = serversWithSource.filter(
      ({ server }) => server.transport === 'http' || server.transport === 'sse'
    );

    codexDebug(
      `   📊 [Codex MCP] Transport breakdown: ${stdioServers.length} STDIO, ${httpServers.length} HTTP/SSE`
    );

    const result: CodexConfigObject = {};
    const authDiagnostics = new McpAuthDiagnosticAccumulator();
    const claimedNames = new Set<string>();

    // Built-in Agor MCP server (streamable HTTP). Token travels via
    // bearer_token_env_var — never in the URL.
    if (mcpToken) {
      const daemonUrl = await getDaemonUrl();
      const agorBearerEnvVar = `AGOR_MCP_${shortId(sessionId)}_AGOR`;
      process.env[agorBearerEnvVar] = mcpToken;

      claimedNames.add('agor');
      result.agor = {
        url: `${daemonUrl}/mcp`,
        bearer_token_env_var: agorBearerEnvVar,
        ...MCP_AUTO_APPROVE,
      };
      applyGatewayMcpStartupGuard(result.agor as CodexConfigObject, requireMcpServers);
      codexDebug(
        `   📝 [Codex MCP] Configuring built-in Agor MCP server (HTTP) at ${daemonUrl}/mcp`
      );
    }

    for (const { server } of stdioServers) {
      const serverName = this.claimMcpServerName(
        server.name,
        claimedNames,
        server.name.toLowerCase() === 'agor' ? 'conflicts with built-in Agor MCP server' : undefined
      );

      const serverConfig: CodexConfigObject = { ...MCP_AUTO_APPROVE };
      applyMcpToolPermissions(serverConfig, server);
      applyGatewayMcpStartupGuard(serverConfig, requireMcpServers);
      codexDebug(`   📝 [Codex MCP] Configuring STDIO server: ${server.name} -> ${serverName}`);
      if (server.command) {
        serverConfig.command = server.command;
        codexDebug('      command: configured');
      }
      if (server.args && server.args.length > 0) {
        serverConfig.args = server.args as CodexConfigValue[];
        codexDebug(`      args: ${server.args.length} configured value(s)`);
      }
      if (server.env && Object.keys(server.env).length > 0) {
        serverConfig.env = server.env as CodexConfigObject;
        codexDebug(`      env vars: ${Object.keys(server.env).length} variable(s)`);
      }

      result[serverName] = serverConfig;
    }

    for (const scoped of httpServers) {
      const { server } = scoped;
      const serverName = this.claimMcpServerName(
        server.name,
        claimedNames,
        server.name.toLowerCase() === 'agor' ? 'conflicts with built-in Agor MCP server' : undefined
      );

      const serverConfig: CodexConfigObject = { ...MCP_AUTO_APPROVE };
      applyMcpToolPermissions(serverConfig, server);
      let canRequireServer = requireMcpServers;
      codexDebug(`   📝 [Codex MCP] Configuring HTTP server: ${server.name} -> ${serverName}`);
      if (server.url) {
        serverConfig.url = server.url;
        // The resolved URL can contain user-derived path/query material. Do
        // not log it; the server name and transport above are sufficient.
      }

      // Resolve the Authorization header via the shared MCP auth helper —
      // covers bearer / JWT (with token-mint) / OAuth (with cached & DB
      // tokens). Codex passes the bearer through `bearer_token_env_var`,
      // while custom headers use `env_http_headers`, so secret values stay
      // out of the SDK's generated `--config` arguments. Non-bearer schemes
      // log a warning since Codex's CLI only supports bearer auth.
      try {
        const authHeaders = await resolveScopedMCPAuthHeaders(scoped, {
          surfaceAuthorityError: true,
        });
        const headers = mergeMCPRemoteHeaders({ custom: server.headers, auth: authHeaders });
        const authHeader = headers?.Authorization;
        const missingRequiredAuth = !!server.auth && server.auth.type !== 'none' && !authHeader;
        const customHeaders = headers ? { ...headers } : undefined;
        if (customHeaders) delete customHeaders.Authorization;
        if (customHeaders && Object.keys(customHeaders).length > 0) {
          // Codex's streamable-HTTP MCP config takes `env_http_headers`: a map
          // of header NAME -> the NAME of an env var whose value Codex reads at
          // runtime. (It will not accept literal header values here the way
          // Claude's `.mcp.json` `headers` object does — that indirection is
          // also what keeps secrets out of the SDK-generated `--config` argv.)
          // The env var name itself is arbitrary to Codex; we synthesize a
          // unique one per session + server + position so concurrent sessions
          // and multi-header servers don't clobber each other in the shared
          // process.env. The index (not the header name) keys the suffix
          // because header names like `X-API-Key` aren't valid env-var
          // identifiers.
          const envHttpHeaders: Record<string, string> = {};
          for (const [index, [headerName, headerValue]] of Object.entries(
            customHeaders
          ).entries()) {
            const envVarName = `AGOR_MCP_${shortId(sessionId)}_${serverName.toUpperCase()}_HEADER_${index + 1}`;
            process.env[envVarName] = headerValue;
            envHttpHeaders[headerName] = envVarName;
          }
          serverConfig.env_http_headers = envHttpHeaders;
          codexDebug(`      custom headers: ${Object.keys(customHeaders).length} header(s)`);
        }
        if (authHeader) {
          const bearerToken = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1];
          if (bearerToken) {
            const envVarName = `AGOR_MCP_${shortId(sessionId)}_${serverName.toUpperCase()}`;
            process.env[envVarName] = bearerToken;
            serverConfig.bearer_token_env_var = envVarName;
            codexDebug(`      auth: ${server.auth?.type ?? 'bearer'} token via ${envVarName}`);
          } else {
            canRequireServer = false;
            console.warn(
              `      ⚠️  auth: resolved Authorization header for "${server.name}" is not a Bearer scheme (Codex CLI only supports bearer); skipping injection`
            );
          }
        } else if (missingRequiredAuth) {
          canRequireServer = false;
          authDiagnostics.recordUnavailable();
        }
      } catch {
        authDiagnostics.recordResolutionFailure();
        canRequireServer = false;
      }

      applyGatewayMcpStartupGuard(serverConfig, canRequireServer);
      result[serverName] = serverConfig;
    }

    const total = stdioServers.length + httpServers.length + (mcpToken ? 1 : 0);
    authDiagnostics.emitSummary('codex');
    if (total > 0) {
      console.info(`✅ [Codex MCP] Configured ${total} MCP server(s)`);
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
          } else if (item.error) {
            mcpOutput = sanitizeMCPExternalError(item.error, { stage: 'runtime' }).message;
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
        `⚠️  [Codex] Fork requested from parent ${shortId(parentSessionId)}, but parent has no Codex thread id; starting fresh`
      );
      return;
    }

    console.log(
      `🍴 [Codex] Forking from parent thread ${shortId(parentSession.sdk_session_id)} via app-server thread/fork`
    );

    const forkedThreadId = await forkCodexThreadViaAppServer(parentSession.sdk_session_id, {
      env: this.buildAppServerEnv(),
    });
    await this.sessionsRepo.update(sessionId, { sdk_session_id: forkedThreadId });
    session.sdk_session_id = forkedThreadId;

    console.log(
      `✅ [Codex] Forked thread ${shortId(parentSession.sdk_session_id)} → ${shortId(forkedThreadId)}`
    );
  }

  /**
   * Env for `codex app-server` sidecar spawns (`thread/fork`, `skills/list`),
   * matching the SDK spawn's auth semantics: subscription mode scrubs API-key
   * vars so the CLI uses `$CODEX_HOME/auth.json`; API-key mode injects
   * `CODEX_API_KEY`.
   */
  private buildAppServerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.useNativeAuth && !this.apiKey) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    } else if (this.apiKey) {
      env.CODEX_API_KEY = this.apiKey;
    }
    return env;
  }

  /**
   * Discover the Codex skills installed for this user/branch (standalone
   * skills plus plugin-shipped ones, already flattened to plugin-qualified
   * names by Codex) and persist them to `session.custom_context.skills` —
   * the same slot the Claude executor fills from its SDK init message — so
   * the prompt composer can offer them in autocomplete.
   *
   * Codex's exec/SDK surface never reports installed skills, so this asks the
   * local `codex app-server` sidecar (`skills/list`) with the branch path as
   * cwd. Fire-and-forget: runs concurrently with the turn, is throttled per
   * session so back-to-back prompts don't respawn the sidecar, and never
   * fails the turn (older Codex CLIs without `skills/list` just log at debug).
   */
  private scheduleCodexSkillsDiscovery(
    sessionId: SessionID,
    session: Pick<Session, 'custom_context'>,
    branchPath: string
  ): void {
    const now = Date.now();
    const state = this.skillsDiscovery.get(sessionId);
    if (
      state &&
      state.cwd === branchPath &&
      (state.inFlight || now - state.at < SKILLS_DISCOVERY_TTL_MS)
    ) {
      return;
    }

    // Executors are intentionally one-task processes, so an in-memory TTL
    // cannot throttle the next prompt. Persist the last successful refresh on
    // the Session and require the embedded ID to match so copied/forked custom
    // context never suppresses discovery for a different Session.
    const persisted = parseCodexSkillsDiscoveryMetadata(
      session.custom_context?.codex_skills_discovery
    );
    if (
      persisted?.session_id === sessionId &&
      persisted.cwd === branchPath &&
      persisted.refreshed_at_ms <= now &&
      now - persisted.refreshed_at_ms < SKILLS_DISCOVERY_TTL_MS
    ) {
      return;
    }

    const inFlight = (async () => {
      const skills = await listCodexSkillsViaAppServer([branchPath], {
        env: this.buildAppServerEnv(),
      });
      const names = skills.map((skill) => skill.name).sort((a, b) => a.localeCompare(b));

      const current = session.custom_context?.skills;
      const unchanged =
        Array.isArray(current) &&
        current.length === names.length &&
        names.every((name, i) => current[i] === name);

      // Repository deep-merges custom_context objects; arrays replace wholesale.
      // The success marker is written even when names are unchanged because it
      // is what makes throttling survive the ephemeral executor process.
      await this.sessionsRepo.update(sessionId, {
        custom_context: {
          ...(!unchanged ? { skills: names } : {}),
          codex_skills_discovery: {
            session_id: sessionId,
            cwd: branchPath,
            refreshed_at_ms: Date.now(),
          },
        },
      });
      codexDebug(`✅ [Codex] Refreshed ${names.length} discovered skill(s) for autocomplete`);
    })();

    this.skillsDiscovery.set(sessionId, { at: now, cwd: branchPath, inFlight });

    void inFlight
      .catch((error) => {
        codexDebug(
          '⚠️ [Codex] Skills discovery failed (autocomplete list not refreshed):',
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        const latest = this.skillsDiscovery.get(sessionId);
        if (latest?.inFlight === inFlight) {
          this.skillsDiscovery.set(sessionId, { at: Date.now(), cwd: branchPath });
        }
      });
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
    abortController?: AbortController,
    onActivity?: SdkActivityCallback
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

    codexDebug(`🔍 [Codex] Starting prompt execution for session ${shortId(sessionId)}`);
    codexDebug(`   Permission mode: ${permissionMode || 'not specified (will use default)'}`);
    codexDebug(`   Existing thread ID: ${session.sdk_session_id || 'none (will create new)'}`);

    // Codex permission settings split across two surfaces:
    // - sandboxMode, approvalPolicy, networkAccessEnabled: per-thread via ThreadOptions
    // - MCP servers + model_instructions_file: per-Codex-instance via CodexOptions.config
    // ThreadOptions are emitted AFTER `--config` flags, so for keys that overlap
    // (approval_policy, sandbox_workspace_write.network_access) ThreadOptions win.
    //
    // The daemon resolver (`resolvePermissionConfig`) always emits a full
    // codex sub-config for new sessions, so this fallback only fires for
    // legacy sessions in the DB with a partial / missing `permission_config`.
    // Derive partial-field fallbacks from the effective mode;
    // mode-less legacy sessions use the same canonical system default.
    const codexConfig = session.permission_config?.codex;
    const effectivePermissionMode =
      permissionMode ?? session.permission_config?.mode ?? getDefaultPermissionMode('codex');
    const defaults = mapToCodexPermissionConfig(effectivePermissionMode);
    // workspace-write uses bwrap not available in pods; override with danger-full-access for k8s.
    const sandboxModeEnvOverride = process.env.AGOR_CODEX_SANDBOX_MODE as
      | CodexSandboxMode
      | undefined;
    const configuredSandboxMode = codexConfig?.sandboxMode ?? defaults.sandboxMode;
    // When Agor wraps the whole executor in its own OS-level sandbox (SRT), do
    // NOT let Codex start its own nested bwrap — run full-access INSIDE Agor's
    // sandbox, which already enforces the filesystem/network boundary. One layer.
    const outerSandbox = process.env.AGOR_OUTER_SANDBOX === '1';
    const sandboxMode: CodexSandboxMode = outerSandbox
      ? 'danger-full-access'
      : (sandboxModeEnvOverride ?? configuredSandboxMode);
    const approvalPolicy = codexConfig?.approvalPolicy ?? defaults.approvalPolicy;
    const networkAccess = codexConfig?.networkAccess ?? defaults.networkAccess;
    // Apps can mutate remote systems outside the filesystem sandbox. Only
    // remove their approval gate for explicit allow-all intent when no
    // per-field or environment override makes the effective policy stricter.
    const shouldAutoApproveApps =
      effectivePermissionMode === 'allow-all' &&
      configuredSandboxMode !== 'read-only' &&
      sandboxModeEnvOverride !== 'read-only' &&
      sandboxMode !== 'read-only' &&
      approvalPolicy === 'never' &&
      networkAccess === true;

    codexDebug(
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
        `⚠️  No MCP token found for session ${shortId(sessionId)} - Agor MCP tools unavailable`
      );
    }

    // forUserId enables per-user OAuth token injection at the MCP scoping
    // layer — the task creator (prompter) when known, else the session owner.
    const forUserId = await resolveContextUserId({
      session,
      taskId,
      tasksService: this.tasksService,
    });
    const requireMcpServers = isGatewaySession(session);
    const { servers: mcpServersConfig, total: mcpServerCount } = await this.buildMcpServersConfig(
      sessionId,
      mcpToken,
      {
        forUserId,
        requireMcpServers,
      }
    );

    const codexConfigPayload: CodexConfigObject = {
      // Agor owns durable task continuation. Codex goals can automatically
      // continue after an internal answer without completing the SDK turn.
      features: { goals: false },
      model_instructions_file: instructionsFile,
      ...(Object.keys(mcpServersConfig).length > 0 ? { mcp_servers: mcpServersConfig } : {}),
      // Codex Apps (for example the GitHub connector supplied by a plugin)
      // use the separate `apps` policy namespace rather than `mcp_servers`.
      // In headless SDK sessions, an approval prompt cannot be answered and
      // is otherwise reported as "user cancelled MCP tool call". Match the
      // effective allow-all policy without broadening restrictive sessions.
      ...(shouldAutoApproveApps
        ? { apps: { _default: { default_tools_approval_mode: 'approve' } } }
        : {}),
    };

    // Recreate Codex instance only if the per-session config payload (or
    // apiKey/baseUrl) actually changed — issue #133 protection.
    await this.ensureCodexClient(codexConfigPayload);

    codexDebug(
      `   Configured: sandboxMode=${sandboxMode}, approvalPolicy=${approvalPolicy}, networkAccess=${networkAccess}, ${mcpServerCount} MCP server(s)`
    );

    // Fetch branch to get working directory
    const branch = this.branchesRepo ? await this.branchesRepo.findById(session.branch_id) : null;
    if (!branch) {
      throw new Error(`Branch ${session.branch_id} not found for session ${sessionId}`);
    }

    codexDebug(`   Working directory: ${branch.path}`);

    // Refresh the composer's skill autocomplete in the background; never
    // blocks or fails the turn.
    this.scheduleCodexSkillsDiscovery(sessionId, session, branch.path);

    await this.ensureForkedCodexThread(sessionId, session);

    // Build thread options. approvalPolicy + networkAccessEnabled flow through
    // here (not config.toml); ThreadOptions override matching `--config` keys.
    // model + modelReasoningEffort are passed through from session.model_config
    // so the UI's per-session model picker actually controls what Codex runs.
    const sessionModel = session.model_config?.model;
    const sessionEffort = session.model_config?.effort;
    const threadOptions = {
      workingDirectory: branch.path,
      skipGitRepoCheck: false,
      sandboxMode,
      approvalPolicy,
      networkAccessEnabled: networkAccess,
      ...(sessionModel ? { model: sessionModel } : {}),
      // Codex CLI accepts `max`; the SDK's ModelReasoningEffort type currently lags it.
      ...(sessionEffort ? { modelReasoningEffort: sessionEffort as CodexSdkReasoningEffort } : {}),
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
      } catch {
        console.warn('⚠️  [Codex] Failed to check MCP server timestamps');
      }
    }

    if (mcpServersAddedAfterCreation && session.sdk_session_id) {
      console.warn(
        `⚠️  [Codex MCP] MCP servers were added after the last SDK sync - current thread won't see them!`
      );
      console.warn(`   🔧 SOLUTION: Clearing sdk_session_id to force fresh thread start`);
      console.warn(
        `   Previous SDK thread: ${shortId(session.sdk_session_id)} (will be discarded)`
      );

      // Clear SDK session ID to force fresh start with new MCP config
      await this.sessionsRepo.update(sessionId, { sdk_session_id: null });
      // Update local session object to reflect the change
      session.sdk_session_id = undefined;
    }

    const resumeThreadId = session.sdk_session_id;
    const startedFreshThread = !resumeThreadId;

    // Check if we need to update thread settings due to approval policy change
    const previousApprovalPolicy = session.permission_config?.codex?.approvalPolicy || 'on-request';
    const approvalPolicyChanged = approvalPolicy !== previousApprovalPolicy;

    // Start or resume thread
    let thread: Thread;
    if (resumeThreadId) {
      codexDebug(`🔄 [Codex] Resuming thread: ${resumeThreadId}`);

      thread = this.getCodexClient().resumeThread(resumeThreadId, threadOptions);

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
          const safe = sanitizeMCPExternalError(error, { stage: 'runtime' });
          console.error(
            `❌ [Codex] Failed to update thread settings category=${safe.category} type=${safe.diagnostic.type}`
          );
          // Continue anyway - the user's prompt will still be sent
        }
      }
    } else {
      codexDebug(`🆕 [Codex] Creating new thread`);
      if (mcpServerCount > 0) {
        codexDebug(
          `✅ [Codex MCP] New thread will have ${mcpServerCount} MCP server(s) available via --config flags`
        );
      }
      thread = this.getCodexClient().startThread(threadOptions);
    }

    let receivedTerminalEvent = false;
    const clearFreshThreadResumeState = async () => {
      if (startedFreshThread) {
        await this.sessionsRepo.update(sessionId, {
          sdk_session_id: null,
        });
      }
    };

    let runtimePhase: 'starting' | 'streaming' = 'starting';
    try {
      codexDebug(
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
      codexDebug(`🎬 [Codex] Starting runStreamed() for session ${shortId(sessionId)}`);
      const turnOptions = abortController ? { signal: abortController.signal } : undefined;
      const { events } = await thread.runStreamed(prompt, turnOptions);
      runtimePhase = 'streaming';
      codexDebug(`✅ [Codex] runStreamed() returned, starting event iteration`);

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
      let latestContextUsage: ContextUsageSnapshot | undefined;
      let observedStreamError: unknown;
      let receivedAssistantMessage = false;

      let eventCount = 0;
      let didStop = false;

      for await (const event of events) {
        eventCount++;
        codexDebug(`📨 [Codex] Event ${eventCount}: ${event.type}`);

        const activityEvent = event as { type: string; payload?: { type?: string } };
        const activityPayloadType =
          activityEvent.type === 'event_msg' ? activityEvent.payload?.type : undefined;
        reportSdkActivity(
          onActivity,
          'codex',
          activityPayloadType ? `${activityEvent.type}.${activityPayloadType}` : activityEvent.type
        );

        // Check if stop was requested
        if (this.stopRequested.get(sessionId)) {
          console.log(`🛑 Stop requested for session ${sessionId}, breaking event loop`);
          this.stopRequested.delete(sessionId);
          didStop = true;
          // Yield stopped event so caller knows execution was stopped early
          yield {
            type: 'stopped',
            threadId: thread.id || undefined,
          };
          break;
        }

        if ((event as { type?: string }).type === 'event_msg') {
          const eventPayload = (event as { payload?: Record<string, unknown> }).payload;
          const payloadType = eventPayload?.type;

          if (payloadType === 'token_count') {
            // Codex emits token_count as generic event_msg payloads.
            // Capture the latest snapshot so turn.completed can return context usage.
            const contextSnapshot = extractCodexContextSnapshotFromEvent(event);
            if (contextSnapshot) {
              latestContextUsage = contextSnapshot;
            }
            continue;
          }

          if (payloadType === 'agent_message') {
            // New Codex rollout format: final assistant text surfaces via event_msg
            // rather than an item.completed(agent_message) item.
            const text =
              typeof eventPayload?.content === 'string'
                ? eventPayload.content
                : typeof eventPayload?.text === 'string'
                  ? eventPayload.text
                  : typeof eventPayload?.message === 'string'
                    ? eventPayload.message
                    : '';
            if (text) {
              receivedAssistantMessage = true;
              currentMessage.push({ type: 'text', text });
            }
            continue;
          }

          if (payloadType === 'task_complete' || payloadType === 'turn_complete') {
            // Terminal completion event from new Codex rollout format.
            // Treat as equivalent to turn.completed.
            receivedTerminalEvent = true;
            threadId = thread.id || '';
            const taskCompleteUsage = extractCodexTokenUsage(
              (eventPayload?.usage ?? eventPayload?.token_usage) as unknown
            );
            const contextUsage =
              latestContextUsage ?? (await extractLatestContextUsageFromRollout(thread.id || ''));

            // Synthesize final assistant text from last_agent_message unless
            // a preceding agent_message event already pushed the same text.
            // This preserves distinct progress/final messages without duplicating.
            const lastAgentMessage =
              typeof eventPayload?.last_agent_message === 'string'
                ? eventPayload.last_agent_message
                : '';
            const hasSameTextContent = currentMessage.some(
              (block) => block.type === 'text' && block.text === lastAgentMessage
            );
            if (lastAgentMessage && !hasSameTextContent) {
              receivedAssistantMessage = true;
              currentMessage.push({ type: 'text', text: lastAgentMessage });
            }

            if (observedStreamError && !receivedAssistantMessage) {
              logCodexRuntimeFailure(
                'turn_completed_without_response',
                observedStreamError,
                sessionId
              );
              throw new CodexLifecycleError('completed_without_response');
            }

            codexDebug(
              `✅ [Codex] terminal event_msg (${payloadType}) received for session ${shortId(sessionId)}`
            );

            yield {
              type: 'complete',
              content: currentMessage,
              toolUses: allToolUses.length > 0 ? allToolUses : undefined,
              threadId,
              resolvedModel,
              usage: taskCompleteUsage,
              rawContextUsage: contextUsage,
            };

            return;
          }

          // Unknown event_msg payload type — ignore silently.
          codexDebug(`[Codex] Unknown event_msg payload type: ${String(payloadType)}`);
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
                const agentMessageText = event.item.text as string;
                if (agentMessageText) receivedAssistantMessage = true;
                const textContent = [{ type: 'text', text: agentMessageText }];

                yield {
                  type: 'complete',
                  content: textContent,
                  threadId: thread.id || '',
                  resolvedModel,
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
                  resolvedModel,
                };
              }

              // Surface non-fatal item-level errors as assistant text so users can see
              // what happened instead of dropping them silently.
              if ('message' in event.item && event.item.type === 'error') {
                const safe = sanitizeMCPExternalError(event.item, { stage: 'runtime' });
                const errorContent = [{ type: 'text', text: `[Codex item error] ${safe.message}` }];
                yield {
                  type: 'complete',
                  content: errorContent,
                  threadId: thread.id || '',
                  resolvedModel,
                };
              }
            }
            break;

          case 'turn.completed': {
            // Turn complete, emit final message
            receivedTerminalEvent = true;
            if (observedStreamError && !receivedAssistantMessage) {
              logCodexRuntimeFailure(
                'turn_completed_without_response',
                observedStreamError,
                sessionId
              );
              throw new CodexLifecycleError('completed_without_response');
            }
            threadId = thread.id || '';
            const mappedUsage = extractCodexTokenUsage((event as { usage?: unknown }).usage);
            const contextUsage =
              latestContextUsage ?? (await extractLatestContextUsageFromRollout(thread.id || ''));

            // Yield complete message with all tool uses
            yield {
              type: 'complete',
              content: currentMessage,
              toolUses: allToolUses.length > 0 ? allToolUses : undefined,
              threadId,
              resolvedModel,
              usage: mappedUsage,
              rawSdkEvent: projectCodexCompletedEvent(event),
              rawContextUsage: contextUsage,
            };

            // Exit the event loop after turn completion
            // Codex SDK doesn't always close the stream properly, so we break manually
            return;
          }

          case 'turn.failed': {
            receivedTerminalEvent = true;
            const missingAuthentication = !this.apiKey && !this.useNativeAuth;
            logCodexRuntimeFailure(
              'turn_failed',
              event.error,
              sessionId,
              missingAuthentication ? 'configuration_required' : undefined
            );
            throw new CodexLifecycleError(
              missingAuthentication ? 'authentication_required' : 'turn_failed'
            );
          }

          case 'error': {
            // Despite the public type's "unrecoverable" wording, Codex exec
            // keeps its event processor running after this notification. In
            // particular, retry progress is projected through this same lossy
            // event shape without the source `will_retry` discriminator. Do
            // not parse provider prose or terminate early: remember the error
            // and wait for the authoritative turn.completed / turn.failed / EOF.
            observedStreamError = event;
            logCodexRuntimeFailure('stream_error_observed', event, sessionId);
            break;
          }

          default:
            // Ignore other event types silently
            break;
        }
      }

      // If we reach here without returning, the stream ended.
      // A user-requested stop is a valid early exit; anything else means Codex
      // exited without emitting a terminal event (turn.completed / task_complete / turn_complete),
      // which is the bug described in issue #1749.
      if (!didStop) {
        throw new CodexLifecycleError('stream_ended_without_completion');
      }
    } catch (error) {
      const wasCancelled = abortController?.signal.aborted === true || isMCPAbortError(error);
      if (wasCancelled) {
        console.log(
          `🛑 [Stop] Codex query aborted for session ${shortId(sessionId)} - this is expected`
        );
        // Yield stopped event to signal execution was halted
        yield { type: 'stopped', threadId: thread.id || undefined };
        // Don't throw - this is a clean stop, not an error
        return;
      }

      if (!receivedTerminalEvent) {
        await clearFreshThreadResumeState();
      }

      if (isKnownCodexBoundaryError(error)) throw error;

      // Convert opaque SDK lifecycle failures to local, fixed control-flow
      // errors. Codex runtime failures emitted as typed events above have already
      // been converted to Codex-specific fixed lifecycle errors.
      throw new CodexLifecycleError(
        runtimePhase === 'starting' ? 'stream_start_failed' : 'stream_interrupted'
      );
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
      } catch {
        // Best-effort cleanup; exception objects may contain reflected paths.
        console.warn('⚠️  Failed to remove a Codex instructions file');
      }
    }
    this.instructionsFilePaths.delete(sessionId);

    // Clean up session-scoped MCP bearer token env vars
    const envPrefix = `AGOR_MCP_${shortId(sessionId)}_`;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(envPrefix)) {
        delete process.env[key];
      }
    }

    // Clean up stop flag
    this.stopRequested.delete(sessionId);
  }
}
