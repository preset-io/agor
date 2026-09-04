import { userInfo } from 'node:os';
import { join } from 'node:path';

export interface EffectiveUserInfo {
  homedir: string;
  shell: string;
}

type UserInfoLookup = () => { homedir: string; shell: string | null };

/**
 * Resolve paths from the executor process's effective uid passwd entry. HOME
 * is intentionally ignored because external launchers may preserve a
 * control-plane HOME while selecting another execution namespace.
 */
export function resolveEffectiveUserInfo(
  lookup: UserInfoLookup = () => userInfo({ encoding: 'utf8' })
): EffectiveUserInfo {
  const info = lookup();
  if (!info.homedir) throw new Error('Executor process has no home directory');
  return { homedir: info.homedir, shell: info.shell || '/bin/sh' };
}

export function resolveCodexAuthPath(
  codexHome: string | undefined = process.env.CODEX_HOME,
  lookup?: UserInfoLookup
): string {
  const home = codexHome || join(resolveEffectiveUserInfo(lookup).homedir, '.codex');
  return join(home, 'auth.json');
}

/**
 * Inside Agor's outer sandbox, bwrap's `--chdir` is the authoritative runtime
 * branch path. It may intentionally use a canonical home alias for continuity
 * with path-keyed SDK state. Outside that boundary, preserve the branch path
 * supplied by the daemon database.
 */
export function resolveExecutorWorkingDirectory(
  branchPath: string,
  outerSandbox = process.env.AGOR_OUTER_SANDBOX === '1',
  getCwd: () => string = process.cwd
): string {
  return outerSandbox ? getCwd() : branchPath;
}

/**
 * Path the Claude Code SDK/CLI reads its subscription OAuth login from on Linux:
 * `${CLAUDE_CONFIG_DIR || ~/.claude}/.credentials.json`. macOS uses the Keychain
 * instead; Agor's executors run on Linux so the file path is authoritative here.
 */
export function resolveClaudeCredentialsPath(
  claudeConfigDir: string | undefined = process.env.CLAUDE_CONFIG_DIR,
  lookup?: UserInfoLookup
): string {
  const home = claudeConfigDir || join(resolveEffectiveUserInfo(lookup).homedir, '.claude');
  return join(home, '.credentials.json');
}
