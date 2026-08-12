import { createGit, resolveGitBinary } from '@agor/core/git';

export interface GitDiagnostic {
  status: 'ready' | 'missing';
  binary?: string;
  version?: string;
  detail?: string;
}

/**
 * Exercise the same configured simple-git path used by repo operations.
 * `version()` is local-only: it neither reads a remote nor needs credentials.
 */
export async function diagnoseGit(): Promise<GitDiagnostic> {
  try {
    const binary = resolveGitBinary();
    const { git } = createGit();
    const result = await git.version();
    if (!result.installed) {
      return {
        status: 'missing',
        detail:
          'Git executable is unavailable. Install Git, ensure it is executable on PATH, ' +
          'and verify `git --version` before retrying.',
      };
    }
    return {
      status: 'ready',
      binary,
      version: `${result.major}.${result.minor}.${result.patch}`,
    };
  } catch (error) {
    return {
      status: 'missing',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
