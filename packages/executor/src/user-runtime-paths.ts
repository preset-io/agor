import { userInfo } from 'node:os';
import { join } from 'node:path';

export interface EffectiveUserInfo {
  homedir: string;
  shell: string;
}

type UserInfoLookup = () => { homedir: string; shell: string | null };

/**
 * Resolve paths from the executor's effective uid passwd entry. HOME is
 * intentionally ignored: sudo configurations commonly preserve the invoking
 * daemon's HOME even though the executor has changed uid.
 */
export function resolveEffectiveUserInfo(
  lookup: UserInfoLookup = () => userInfo({ encoding: 'utf8' })
): EffectiveUserInfo {
  const info = lookup();
  if (!info.homedir) throw new Error('Effective Unix user has no home directory');
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
