/**
 * Shared routing + option plumbing for the credential-file executor commands
 * (`codex.auth-file`, `claude.auth-file`). The daemon derives the identity from
 * the authenticated user, never request data, and every call marks its output
 * sensitive so token bytes never reach executor logs.
 */
export interface ExecutorCredentialRouting {
  delegatedHomeKey: string | null;
  userId: string;
  /**
   * Explicit `CODEX_HOME` (the `.codex` dir) for the Codex auth-file executor.
   * Set in per-user sandbox mode so auth persists where sessions read it.
   */
  codexHome?: string;
  /** Explicit Claude config directory for the same per-user sandbox home. */
  claudeConfigDir?: string;
}

export function credentialExecutorOptions(logPrefix: string, routing: ExecutorCredentialRouting) {
  return {
    delegatedHomeKey: routing.delegatedHomeKey ?? undefined,
    templateVariables: {
      unix_user: routing.delegatedHomeKey ?? undefined,
      user_id: routing.userId,
    },
    // In sandbox mode the auth flow runs unsandboxed as the daemon user, but the
    // executor resolves the auth file from CODEX_HOME. Point it at the caller's
    // per-user store `.codex` so the write lands where the SANDBOXED session (with
    // that store overlaid at ~) will later read it — otherwise auth.json goes to
    // the daemon home and the session can't see it. Merge OVER process.env
    // (options.env REPLACES the spawn env), keeping PATH/keys/etc.
    ...(routing.codexHome || routing.claudeConfigDir
      ? {
          env: {
            ...(process.env as Record<string, string>),
            ...(routing.codexHome ? { CODEX_HOME: routing.codexHome } : {}),
            ...(routing.claudeConfigDir ? { CLAUDE_CONFIG_DIR: routing.claudeConfigDir } : {}),
          },
        }
      : {}),
    sensitiveOutput: true,
    timeoutMs: 10_000,
    logPrefix,
  };
}
