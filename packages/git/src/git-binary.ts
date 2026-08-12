import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const COMMON_GIT_PATHS = [
  '/opt/homebrew/bin/git', // Homebrew on Apple Silicon
  '/usr/local/bin/git', // Homebrew on Intel
  '/usr/bin/git', // System git (Docker and Linux)
] as const;

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the Git executable without spawning a shell. */
export function resolveGitBinary(
  options: {
    path?: string;
    platform?: NodeJS.Platform;
    isExecutable?: (path: string) => boolean;
    commonPaths?: readonly string[];
  } = {}
): string {
  const isExecutable = options.isExecutable ?? canExecute;
  const commonPaths = options.commonPaths ?? COMMON_GIT_PATHS;

  for (const path of commonPaths) {
    if (isExecutable(path)) return path;
  }

  const platform = options.platform ?? process.platform;
  const names = platform === 'win32' ? ['git.exe', 'git.cmd', 'git.bat', 'git'] : ['git'];
  for (const directory of (options.path ?? process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }

  throw new Error(
    'Git executable is unavailable. Install Git, ensure it is executable on PATH, ' +
      'and verify `git --version` before retrying.'
  );
}
