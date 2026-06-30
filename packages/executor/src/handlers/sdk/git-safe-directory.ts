import type { SessionID } from '@agor/core/types';
import { buildGitConfigParameters } from '../../git/index.js';
import type { AgorClient } from '../../services/feathers-client.js';

type BranchForSafeDirectory = {
  path?: string | null;
  repo_id?: string | null;
};

type RepoForSafeDirectory = {
  local_path?: string | null;
};

const DEBUG_GIT_SAFE_DIRECTORY =
  process.env.AGOR_DEBUG_GIT_SAFE_DIRECTORY === '1' ||
  process.env.DEBUG?.includes('git-safe-directory');

function gitSafeDirectoryDebug(...args: unknown[]): void {
  if (DEBUG_GIT_SAFE_DIRECTORY) {
    console.debug(...args);
  }
}

function appendGitConfigParameterPairs(pairs: readonly string[]): void {
  const encoded = buildGitConfigParameters(pairs);
  if (!encoded) return;

  const existing = process.env.GIT_CONFIG_PARAMETERS?.trim();
  process.env.GIT_CONFIG_PARAMETERS = existing ? `${existing} ${encoded}` : encoded;
}

/**
 * Trust the managed checkout paths for every git subprocess the SDK agent starts.
 *
 * The daemon/executor itself already routes branch inspection through executor
 * commands with explicit `-c safe.directory=...` arguments, but interactive
 * agents can still run plain `git status` inside their sessions. In insulated
 * and strict Unix modes the session user may be a group member rather than the
 * checkout owner, so git's ownership check rejects the repo unless the session
 * process environment preconfigures these directories as safe.
 *
 * We use `GIT_CONFIG_PARAMETERS` instead of mutating the user's global
 * ~/.gitconfig: it is scoped to this executor process and inherited by the
 * Codex/Claude/Gemini/OpenCode child processes and their shell commands.
 */
export async function configureSessionGitSafeDirectories(
  client: AgorClient,
  sessionId: SessionID,
  logPrefix = '[git.safe-directory]'
): Promise<string[]> {
  const paths: string[] = [];

  try {
    const session = await client.service('sessions').get(sessionId);
    if (!session?.branch_id) return paths;

    const branch = (await client
      .service('branches')
      .get(session.branch_id)) as BranchForSafeDirectory;
    if (branch?.path) paths.push(branch.path);

    if (branch?.repo_id) {
      try {
        const repo = (await client.service('repos').get(branch.repo_id)) as RepoForSafeDirectory;
        if (repo?.local_path) paths.push(repo.local_path);
      } catch (error) {
        console.warn(
          `${logPrefix} Failed to load repo ${branch.repo_id} for safe.directory setup:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to resolve session ${sessionId} safe.directory paths:`,
      error instanceof Error ? error.message : String(error)
    );
    return paths;
  }

  const uniquePaths = Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
  appendGitConfigParameterPairs(uniquePaths.map((path) => `safe.directory=${path}`));

  if (uniquePaths.length > 0) {
    gitSafeDirectoryDebug(
      `${logPrefix} Added ${uniquePaths.length} safe.directory entr${uniquePaths.length === 1 ? 'y' : 'ies'} for session git commands`
    );
  }

  return uniquePaths;
}
