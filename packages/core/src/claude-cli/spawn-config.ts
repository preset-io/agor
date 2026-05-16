/**
 * Build the argv for spawning the `claude` shell binary in a Zellij pane.
 *
 * Verified against `claude` v2.1.132. We use the **interactive** subset of
 * flags (NO `-p`/`--print`) — see the analysis doc's "Policy & ToS landscape"
 * section for why the print-mode path is deliberately avoided.
 *
 * Flags we emit (when applicable):
 *
 *   --session-id <uuid>            REQUIRED. Maps agor.session_id ↔ claude session.
 *   --resume <id>                  Resume an existing session by id.
 *   --fork-session                 With --resume, mint a new session-id.
 *   --model <alias>                e.g. claude-opus-4-7. Stripped of [1m] suffix.
 *   --betas <flag>                 e.g. context-1m-2025-08-07 (only with [1m] models).
 *   --effort <level>               low | medium | high | xhigh | max
 *   --permission-mode <mode>       default|acceptEdits|bypassPermissions|plan|dontAsk|auto.
 *                                  Mutually exclusive with --dangerously-skip-permissions.
 *   --dangerously-skip-permissions Distinct argv per Anthropic's flag design — same
 *                                  runtime as bypassPermissions, separate telemetry.
 *   --mcp-config <file>            JSON file with Agor + scoped user MCPs.
 *   --strict-mcp-config            Ignore the user's other MCP sources.
 *   --add-dir <dir...>             Extra context/work dirs beyond cwd.
 *   --append-system-prompt-file <f> Path to a file Agor wrote with session context.
 *   -n <name>                      Display name (shown in /resume picker + terminal title).
 *
 * Print-only flags we deliberately DO NOT emit: `-p`, `--output-format`,
 * `--input-format`, `--include-partial-messages`, `--include-hook-events`,
 * `--max-budget-usd`, `--no-session-persistence`, `--replay-user-messages`.
 */

// Model alias parsing: a trailing `[1m]` suffix enables the 1M context window
// via the `context-1m-2025-08-07` beta flag. Inlined here so spawn-config can
// live in @agor/core without depending on the executor's SDK utilities.
const CONTEXT_1M_BETA = 'context-1m-2025-08-07';
const MODEL_1M_SUFFIX = '[1m]';

function parseModelWithBetas(rawModel: string): { model: string; betas: string[] } {
  if (rawModel.endsWith(MODEL_1M_SUFFIX)) {
    return {
      model: rawModel.slice(0, -MODEL_1M_SUFFIX.length),
      betas: [CONTEXT_1M_BETA],
    };
  }
  return { model: rawModel, betas: [] };
}

/**
 * Permission modes the CLI accepts. Mirrors the SDK's `ClaudeCodePermissionMode`
 * union but extended with `auto` and the synthetic `dangerously-skip-permissions`
 * marker — picked from the user-facing Defaults dropdown (analysis doc § Claude
 * Code CLI Defaults panel).
 *
 * `dangerously-skip-permissions` emits the dedicated argv flag rather than
 * `--permission-mode bypassPermissions`. Runtime is identical; telemetry differs.
 */
export type ClaudeCliPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
  | 'dangerously-skip-permissions';

export interface ClaudeCliSpawnConfig {
  /**
   * The session-id the CLI will use. Agor mints this — typically equals the
   * Agor session_id (UUIDv7). If omitted, the CLI generates its own and the
   * caller has to discover it by tailing the slug dir for a new JSONL file.
   * Strongly prefer setting this.
   */
  sessionId?: string;

  /** Resume an existing session by claude-side session id. */
  resumeSessionId?: string;

  /**
   * With `resumeSessionId`, mint a new session id (true fork at the CLI
   * level — capability flag `supportsSessionFork`).
   */
  forkSession?: boolean;

  /** Display name (terminal title + /resume picker label). */
  displayName?: string;

  /**
   * Model alias — `claude-opus-4-7`, `claude-sonnet-4-6`, etc. A trailing
   * `[1m]` suffix enables the 1M context window via the `context-1m-2025-08-07`
   * beta flag.
   */
  model?: string;

  /** Reasoning effort. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';

  /** Permission handling at spawn. See type comment. */
  permissionMode?: ClaudeCliPermissionMode;

  /** Absolute path to per-session MCP config tmp file. */
  mcpConfigPath?: string;

  /**
   * When MCP config is set, also pass `--strict-mcp-config` so the user's
   * other MCP sources are ignored. Defaults to `true` since we always want
   * Agor MCP-only at spawn.
   */
  strictMcp?: boolean;

  /** Extra `--add-dir` paths beyond cwd. */
  addDirs?: string[];

  /** Absolute path to a system-prompt file Agor wrote at spawn. */
  appendSystemPromptFile?: string;

  /**
   * Additional raw argv to append. Power-user escape hatch for flags we
   * don't model explicitly. Caller is responsible for shell-safety.
   */
  extraArgs?: string[];
}

export interface BuiltSpawn {
  /** `claude` */
  bin: string;
  /** Argv (does NOT include the binary itself). */
  args: string[];
}

const PERMISSION_MODE_FLAG_VALUES: ReadonlySet<ClaudeCliPermissionMode> = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);

/**
 * Static map from the SDK-wide `PermissionMode` union to the CLI's
 * argv flag. Anything not in this table (e.g. Gemini/Codex modes that
 * leak through `permission_config.mode`) returns `undefined`, which
 * `buildClaudeCliSpawn` treats as "don't emit the flag" — claude
 * falls back to its own default (`default` / prompt-on-every-tool).
 *
 * Lives alongside `ClaudeCliPermissionMode` so the type union and its
 * mapper move in lockstep when Anthropic adds new modes.
 */
const PERMISSION_MODE_MAP: Partial<Record<string, ClaudeCliPermissionMode>> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  bypassPermissions: 'bypassPermissions',
  plan: 'plan',
  dontAsk: 'dontAsk',
};

/**
 * Resolve the SDK's `permission_config.mode` to the CLI's argv flag.
 * Returns `acceptEdits` as the v1 default for user-driven sessions when
 * no mode is configured, mirroring the Defaults-panel out-of-box choice
 * in the analysis doc.
 */
export function permissionModeForCli(
  mode: string | null | undefined
): ClaudeCliPermissionMode | undefined {
  if (!mode) return 'acceptEdits';
  return PERMISSION_MODE_MAP[mode];
}

/**
 * Build the spawn invocation for the `claude` binary.
 *
 * Pure function — no fs / process side-effects. Caller (the Zellij command
 * handler) decides how to actually exec it.
 */
export function buildClaudeCliSpawn(cfg: ClaudeCliSpawnConfig): BuiltSpawn {
  const args: string[] = [];

  if (cfg.resumeSessionId) {
    args.push('--resume', cfg.resumeSessionId);
    if (cfg.forkSession) args.push('--fork-session');
  } else if (cfg.sessionId) {
    args.push('--session-id', cfg.sessionId);
  }

  if (cfg.displayName) {
    args.push('-n', cfg.displayName);
  }

  if (cfg.model) {
    const { model, betas } = parseModelWithBetas(cfg.model);
    args.push('--model', model);
    for (const beta of betas) {
      args.push('--betas', beta);
    }
  }

  if (cfg.effort) {
    args.push('--effort', cfg.effort);
  }

  if (cfg.permissionMode) {
    if (cfg.permissionMode === 'dangerously-skip-permissions') {
      args.push('--dangerously-skip-permissions');
    } else if (PERMISSION_MODE_FLAG_VALUES.has(cfg.permissionMode)) {
      args.push('--permission-mode', cfg.permissionMode);
    }
    // Unknown values silently dropped — schema validation upstream.
  }

  if (cfg.mcpConfigPath) {
    args.push('--mcp-config', cfg.mcpConfigPath);
    if (cfg.strictMcp !== false) args.push('--strict-mcp-config');
  }

  if (cfg.addDirs && cfg.addDirs.length > 0) {
    args.push('--add-dir', ...cfg.addDirs);
  }

  if (cfg.appendSystemPromptFile) {
    args.push('--append-system-prompt-file', cfg.appendSystemPromptFile);
  }

  if (cfg.extraArgs && cfg.extraArgs.length > 0) {
    args.push(...cfg.extraArgs);
  }

  return { bin: 'claude', args };
}

/**
 * Render `claude <args...>` as a shell-safe command string suitable for
 * passing to `zellij action new-tab --command` (which spawns one binary
 * with argv, not a full shell). Each argv element is quoted separately.
 *
 * Zellij's `new-tab --command` actually accepts a binary and `--args`;
 * see `formatForZellijNewTab` for the shape we usually want.
 */
export function formatAsShellCommand(built: BuiltSpawn): string {
  const parts = [built.bin, ...built.args];
  return parts.map((p) => quoteForShell(p)).join(' ');
}

/**
 * Zellij's `new-tab` takes `--command <bin>` plus repeated `--args <one>` for
 * each argv element. This helper gives back the flag bundle we'd append.
 *
 * Example:
 *   formatForZellijNewTab(built)
 *   // => ['--command', 'claude', '--args', '--session-id', '--args', '...']
 */
export function formatForZellijNewTab(built: BuiltSpawn): string[] {
  const out: string[] = ['--command', built.bin];
  for (const arg of built.args) {
    out.push('--args', arg);
  }
  return out;
}

/**
 * Minimal shell-quoting for `formatAsShellCommand`. Strict single-quote
 * wrapping with embedded single-quote escape (`'\''`). Sufficient for our
 * controlled argv (we never accept raw user shell strings).
 */
function quoteForShell(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
