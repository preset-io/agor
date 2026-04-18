/**
 * Environment Command Spawn Utilities
 *
 * Wraps environment commands (start/stop/nuke/logs/health) with Unix impersonation.
 * Reuses existing impersonation logic from run-as-user and user-manager.
 */

import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { createUserProcessEnvironment } from '../config/index.js';
import type { Database } from '../db/index.js';
import { UsersRepository } from '../db/repositories/index.js';
import type { Worktree } from '../types/index.js';
import { assertEnvCommandAllowed } from './environment-command-deny-list.js';
import { buildSpawnArgs } from './run-as-user.js';
import { attachEnvFileCleanup, prepareImpersonationEnv } from './user-env-file.js';
import { resolveUnixUserForImpersonation, validateResolvedUnixUser } from './user-manager.js';

/**
 * Environment command types for logging
 */
export type EnvironmentCommandType = 'start' | 'stop' | 'nuke' | 'logs' | 'health';

export interface SpawnEnvironmentCommandOptions {
  /** The shell command to execute */
  command: string;
  /** The worktree this command is running for */
  worktree: Worktree;
  /** Database instance (for user lookup and config) */
  db: Database;
  /** Command type for logging */
  commandType: EnvironmentCommandType;
  /** stdio configuration (default: 'inherit') */
  stdio?: SpawnOptions['stdio'];
  /**
   * Identity of the user who triggered the command. Used for audit logging
   * only — authorization is enforced at the service layer.
   */
  triggeredBy?: { user_id?: string; email?: string };
}

/**
 * Structured audit entry emitted (as a single JSON line) whenever an env
 * command is spawned. Captures who/what/where so trigger history can be
 * reconstructed from daemon logs. We do not persist these rows — the
 * daemon's journald/docker logs are the source of truth.
 */
export interface EnvCommandAuditEntry {
  event: 'agor.env_command.spawn';
  timestamp: string;
  worktree_id: string;
  worktree_name: string;
  command_type: EnvironmentCommandType;
  /**
   * Command string as spawned, after secret redaction and length truncation.
   * Inline `KEY=value` pairs whose key matches a secret-looking name are
   * replaced with `KEY=***`. Commands longer than AUDIT_COMMAND_MAX_LENGTH
   * are truncated with a trailing marker.
   */
  command: string;
  triggered_by_user_id: string | undefined;
  triggered_by_email: string | undefined;
  as_unix_user: string | undefined;
  unix_user_mode: string;
}

/**
 * Keys whose inline assignment values should be redacted from audit logs.
 * Matched case-insensitively as a suffix of the key (so `MY_API_KEY` and
 * `DATABASE_PASSWORD` both redact). Agor sources real secrets via an env-file
 * out of /proc/PID/cmdline, but users routinely paste `FOO_TOKEN=abc docker …`
 * into templates, so this keeps those from leaking into daemon logs.
 */
const SECRET_KEY_PATTERN =
  /(?:^|[\s;&|])((?:[A-Z_][A-Z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CRED|CREDENTIAL|AUTH|API|PRIVATE|SIGNATURE))=(\S+)/gi;

/** Max length of the command string emitted in an audit entry. */
const AUDIT_COMMAND_MAX_LENGTH = 1024;

/**
 * Produce the command string that goes into the audit log: redacts inline
 * `KEY=value` pairs for secret-looking keys and truncates. Not a security
 * boundary — the real secret path is the env-file — just keeps honest logs
 * honest.
 */
export function redactCommandForAudit(command: string): string {
  const redacted = command.replace(SECRET_KEY_PATTERN, (match, key) => {
    const leader = match.startsWith(key) ? '' : match[0];
    return `${leader}${key}=***`;
  });
  if (redacted.length <= AUDIT_COMMAND_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, AUDIT_COMMAND_MAX_LENGTH)}…[truncated]`;
}

/**
 * Spawn an environment command with conditional Unix impersonation
 *
 * Automatically handles:
 * - Loading Unix user mode config
 * - Looking up user's unix_username
 * - Creating clean user process environment
 * - Resolving impersonation based on mode
 *
 * Behavior based on unix_user_mode:
 * - simple: No impersonation, run as daemon user
 * - insulated: Run as executor_unix_user (if configured)
 * - strict: Run as user's unix_username
 *
 * @param options - Spawn configuration
 * @returns Child process
 */
export async function spawnEnvironmentCommand(
  options: SpawnEnvironmentCommandOptions
): Promise<ChildProcess> {
  const { command, worktree, db, commandType, stdio = 'inherit', triggeredBy } = options;

  const logPrefix = `[Environment.${commandType} ${worktree.name}]`;

  // Defence-in-depth: refuse obviously-dangerous commands even if an admin
  // authored them. Runs on every spawn path (REST, MCP, WebSocket).
  assertEnvCommandAllowed(command, commandType);

  // Load config for Unix impersonation settings
  const { loadConfig } = await import('../config/config-manager.js');
  const config = await loadConfig();
  const unixUserMode = config.execution?.unix_user_mode ?? 'simple';

  // Resolve impersonation user first to determine if we need impersonation-safe env
  let asUser: string | undefined;

  if (unixUserMode !== 'simple') {
    // Look up user's unix_username
    const usersRepo = new UsersRepository(db);
    const user = await usersRepo.findById(worktree.created_by);

    const impersonationResult = resolveUnixUserForImpersonation({
      mode: unixUserMode,
      userUnixUsername: user?.unix_username,
      executorUnixUser: config.execution?.executor_unix_user,
    });

    asUser = impersonationResult.unixUser ?? undefined;

    if (asUser) {
      validateResolvedUnixUser(unixUserMode, asUser);
      console.log(
        `${logPrefix} Running as user: ${asUser} (reason: ${impersonationResult.reason})`
      );
    } else {
      console.log(`${logPrefix} Running as daemon user (reason: ${impersonationResult.reason})`);
    }
  } else {
    console.log(`${logPrefix} Running as daemon user (mode: ${unixUserMode})`);
  }

  // Create clean environment for user process
  // If impersonating, strip HOME/USER/LOGNAME/SHELL so sudo -u can set them properly
  const env = await createUserProcessEnvironment(worktree.created_by, db, undefined, !!asUser);

  // Route secret-looking env vars through an on-disk env file owned by the
  // target user (mode 0600) so user-scoped API keys/tokens never appear in
  // the `sudo bash -c '...'` argv exposed to /proc/<pid>/cmdline.
  const prepared = asUser
    ? prepareImpersonationEnv({ asUser, env })
    : { inlineEnv: undefined, envFilePath: undefined };

  // Build spawn args with impersonation.
  //
  // `shell: true` is critical here: env commands are user-authored shell
  // strings (e.g. `SEED=true UID=$(id -u) docker compose up -d --build`)
  // that need shell parsing — env-var prefixes, `$(...)` subshells, argument
  // word-splitting, etc. Without this, the impersonated + secret-file path
  // emits `exec "$@"` which treats the whole string as a single program
  // name and fails with `exec: <full string>: not found`.
  const { cmd, args } = buildSpawnArgs(command, [], {
    asUser,
    env: asUser ? prepared.inlineEnv : undefined, // Non-secret env only; secrets are sourced from envFilePath
    envFilePath: prepared.envFilePath,
    shell: true,
  });

  // Structured audit log — one JSON line per spawn for post-hoc review
  // (daemon logs are the source of truth; we do not persist these to the DB).
  const auditEntry: EnvCommandAuditEntry = {
    event: 'agor.env_command.spawn',
    timestamp: new Date().toISOString(),
    worktree_id: worktree.worktree_id,
    worktree_name: worktree.name,
    command_type: commandType,
    command: redactCommandForAudit(command),
    triggered_by_user_id: triggeredBy?.user_id,
    triggered_by_email: triggeredBy?.email,
    as_unix_user: asUser,
    unix_user_mode: unixUserMode,
  };
  console.log(`AUDIT ${JSON.stringify(auditEntry)}`);

  // Spawn the command
  // When not impersonating (simple mode), buildSpawnArgs returns the raw command string,
  // so we need shell: true to handle multi-word commands like "docker compose up -d"
  const child = spawn(cmd, args, {
    cwd: worktree.path,
    env: asUser ? undefined : env, // Use process env if not impersonating
    stdio,
    shell: !asUser, // Use shell for simple mode, buildSpawnArgs wraps sudo in bash -c
  });

  // Safety-net cleanup. The inner bash script `rm -f`s the file before exec
  // in the normal path, so this only fires if sudo/bash fails to launch, or
  // if `set -eu` aborts the source step. Uses sudo when asUser is set so
  // it works under sticky /tmp.
  attachEnvFileCleanup(child, { envFilePath: prepared.envFilePath, asUser });

  return child;
}
