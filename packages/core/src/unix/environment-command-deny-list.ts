/**
 * Env Command Deny-List
 *
 * Defence-in-depth check that refuses to spawn env commands matching
 * obviously-dangerous patterns. Admin authoring is already gated by
 * `requireAdminForEnvConfig`; this is a belt-and-braces guard at spawn
 * time for known host-root footguns.
 *
 * Philosophy:
 * - Deny only patterns that are (a) obviously destructive or (b) trivially
 *   able to escape the worktree sandbox. Env commands are intentionally
 *   varied (docker, pnpm, make, custom scripts), so this list is short.
 * - Regexes operate on the final shell string. Pattern matching shell
 *   strings is *not* a hard boundary — real isolation is Unix users +
 *   filesystem permissions. This catches copy-paste mistakes and
 *   compromised-repo scenarios, not a determined insider.
 */

export interface DenyPattern {
  /** Regex against the full shell-string command */
  pattern: RegExp;
  /** Human-readable reason shown in the error and audit log */
  description: string;
}

/**
 * Ordered list of deny patterns. Add sparingly — false positives here
 * break real user workflows (docker compose down, make clean, etc.).
 */
export const ENV_COMMAND_DENY_PATTERNS: readonly DenyPattern[] = [
  {
    // `rm -rf /`, `rm -fr /`, `rm -rfv /` etc. — host-root deletion.
    // Anchored on word boundary + flag cluster + literal `/` at end-of-token.
    pattern: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$|;|&|\|)/,
    description: 'rm -rf on host root',
  },
  {
    // `rm ... --no-preserve-root ...` — the flag exists specifically to allow
    // recursive delete of `/` on systems that otherwise refuse. No legitimate
    // env command needs it, and it catches order-swapped variants that the
    // pattern above misses (e.g. `rm -rf --no-preserve-root /`).
    pattern: /\brm\b[^|&;\n]*\s--no-preserve-root\b/,
    description: 'rm with --no-preserve-root (host-root deletion bypass)',
  },
  {
    // Mounting host root into a container (`-v /:/...`, `--volume /:/...`).
    pattern: /(?:^|\s)(?:-v|--volume)(?:\s+|=)\/:/,
    description: 'docker volume mount of host root (/)',
  },
  {
    // Mounting host /etc or /root into a container.
    pattern: /(?:^|\s)(?:-v|--volume)(?:\s+|=)\/(?:etc|root|var\/run\/docker\.sock)\b/,
    description: 'docker volume mount of host /etc, /root, or docker.sock',
  },
  {
    // Creating filesystems — almost never legitimate in an env command.
    pattern: /\bmkfs(?:\.[a-zA-Z0-9]+)?\s/,
    description: 'filesystem format (mkfs)',
  },
  {
    // Writing raw bytes to a block device.
    pattern: /\bdd\s+[^|&;\n]*\bof=\/dev\//,
    description: 'dd to raw device (/dev/*)',
  },
  {
    // Piping curl/wget output directly into a shell — a classic supply-chain
    // footgun. Matches `curl … | sh`, `wget … | bash`, including `sudo sh`.
    pattern: /\b(?:curl|wget)\b[^|&;\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)(?:\s|$)/,
    description: 'piping network download directly into a shell',
  },
];

export class EnvCommandDeniedError extends Error {
  public readonly matched: DenyPattern;
  public readonly commandType: string;

  constructor(matched: DenyPattern, commandType: string, command: string) {
    super(
      `Env command blocked by deny-list (${matched.description}). ` +
        `commandType=${commandType} command=${command.substring(0, 200)}`
    );
    this.name = 'EnvCommandDeniedError';
    this.matched = matched;
    this.commandType = commandType;
  }
}

/**
 * Throw if the given command matches any deny pattern.
 *
 * Called at spawn time from `spawnEnvironmentCommand` so it runs regardless
 * of how the command was authored (config template, .agor.yml import, direct
 * worktree edit) and regardless of caller (REST, MCP, WebSocket).
 */
export function assertEnvCommandAllowed(command: string, commandType: string): void {
  for (const entry of ENV_COMMAND_DENY_PATTERNS) {
    if (entry.pattern.test(command)) {
      throw new EnvCommandDeniedError(entry, commandType, command);
    }
  }
}
