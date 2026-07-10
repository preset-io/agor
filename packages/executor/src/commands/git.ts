/**
 * Git Command Handlers for Executor
 *
 * These handlers execute git operations directly in the executor process.
 * This enables:
 * 1. Running as a different Unix user with fresh group memberships
 * 2. Proper isolation for RBAC-protected branches
 * 3. Consistent environment (credentials, env vars) resolution
 *
 * The executor handles the complete transaction:
 * 1. Filesystem operations (git clone, git worktree add/remove)
 * 2. Database record creation via Feathers services
 * 3. Privileged Unix group/ACL setup is delegated to the daemon via Feathers RPC
 *    (`repos.initializeUnixGroup`, `branches.initializeUnixGroup`) so it runs
 *    with daemon sudo privileges regardless of executor impersonation mode.
 *
 * Feathers hooks handle WebSocket broadcasts automatically when records are created/updated.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgorYml, writeAgorYml } from '@agor/core/config';
import { shortId } from '@agor/core/db';
import {
  categorizeGitError,
  cleanBranch,
  cloneRepo,
  createBranch,
  createBranchAsClone,
  createGit,
  deleteBranch,
  deleteBranchDirectory,
  deleteRepoDirectory,
  ensureGitRemoteUrl,
  getReposDir,
  redactGitUrlCredentials,
  removeGitWorktree,
  restoreBranchFilesystem,
  stripGitUrlCredentials,
} from '../git/index.js';
import type {
  BranchAgorYmlExportPayload,
  BranchAgorYmlImportPayload,
  BranchFilesListPayload,
  BranchInspectPayload,
  ExecutorResult,
  GitBranchAddPayload,
  GitBranchCleanPayload,
  GitBranchRemovePayload,
  GitClonePayload,
  GitRepoDeletePayload,
  GitRepoRealignOriginPayload,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';
import { fixBranchGitDirPermissionsBasic } from './unix.js';

/**
 * Fetch the requesting user's git environment via Feathers RPC.
 *
 * Calls `users.getGitEnvironment` on the daemon, which decrypts the user's
 * stored env vars (GITHUB_TOKEN, etc.) and returns them. Returns an empty
 * object only when no userId is provided (e.g. local-path repos that skip
 * credentials entirely).
 *
 * RPC failures are intentionally NOT swallowed: this is the channel through
 * which per-user credentials reach git ops in strict mode. If we returned `{}`
 * on failure, git would silently fall back to the daemon user's ambient
 * credentials (e.g. `gh auth login`), which is exactly the cross-user leak
 * this whole flow is designed to prevent.
 */
async function fetchUserGitEnvironment(
  client: AgorClient,
  userId: string | undefined
): Promise<Record<string, string>> {
  if (!userId) return {};
  return client.service('users').getGitEnvironment({ userId });
}

/**
 * Compute repo slug from URL
 *
 * Examples:
 * - https://github.com/preset-io/agor.git -> preset-io/agor
 * - git@github.com:preset-io/agor.git -> preset-io/agor
 * - /local/path/to/repo -> local-path-to-repo
 */
function computeRepoSlug(url: string): string {
  // Handle SSH URLs: git@github.com:org/repo.git
  const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // Handle HTTPS URLs: https://github.com/org/repo.git
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return pathname;
  } catch {
    // Not a valid URL, use the path as-is (sanitized)
    return url.replace(/[^a-zA-Z0-9\-_]/g, '-').replace(/^-+|-+$/g, '');
  }
}

/**
 * Extract repo name from slug
 */
function extractRepoName(slug: string): string {
  const parts = slug.split('/');
  return parts[parts.length - 1] || slug;
}

interface FileResult {
  path: string;
  type: 'file' | 'folder';
}

function buildFileResults(rawLsFiles: string, search: string, limit: number): FileResult[] {
  if (!search || search.trim() === '') return [];

  const allFiles = rawLsFiles.split('\0').filter((filePath) => filePath.length > 0);
  const foldersSet = new Set<string>();

  for (const filePath of allFiles) {
    const parts = filePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      foldersSet.add(parts.slice(0, i).join('/'));
    }
  }

  const searchLower = search.toLowerCase();

  const matchingFiles = allFiles
    .filter((filePath) => filePath.toLowerCase().includes(searchLower))
    .map((path) => ({ path, type: 'file' as const }));

  const matchingFolders = Array.from(foldersSet)
    .map((path) => `${path}/`)
    .filter((folderPath) => folderPath.toLowerCase().includes(searchLower))
    .map((path) => ({ path, type: 'folder' as const }));

  return [...matchingFolders, ...matchingFiles].slice(0, limit);
}

/**
 * Handle branch.files.list command.
 * Lists tracked files/folders from the branch checkout for prompt autocomplete.
 */
export async function handleBranchFilesList(
  payload: BranchFilesListPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const branchId = payload.params.branchId;
  const search = payload.params.search;
  const limit = payload.params.limit ?? 10;

  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'branch.files.list',
        branchId,
        search,
        limit,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);

    const branch = await client.service('branches').get(branchId);
    if (!branch?.path) {
      return { success: true, data: { results: [] } };
    }

    const { git } = createGit(branch.path);
    const raw = await git.raw(['ls-files', '-z']);
    const results = buildFileResults(raw, search, limit);

    return {
      success: true,
      data: {
        branchId,
        results,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[branch.files.list] Failed:', errorMessage);
    return {
      success: false,
      error: {
        code: 'BRANCH_FILES_LIST_FAILED',
        message: errorMessage,
        details: { branchId },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle branch.inspect command.
 * Reads current git SHA/ref from the branch checkout.
 */
export async function handleBranchInspect(
  payload: BranchInspectPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const branchId = payload.params.branchId;

  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'branch.inspect',
        branchId,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);

    const branch = await client.service('branches').get(branchId);
    if (!branch?.path) {
      throw new Error(`Branch ${branchId} has no path`);
    }

    const repo = await prepareBranchInspectionGitConfig(client, branch);
    const { currentSha, currentRef } = await readBranchInspectState({
      branchPath: branch.path,
      repoPath: repo?.local_path,
      fallbackRef: branch.name || '',
      logPrefix: `[branch.inspect ${branchId}]`,
    });

    return {
      success: true,
      data: {
        branchId,
        currentSha,
        currentRef,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[branch.inspect] Failed:', errorMessage);
    return {
      success: false,
      error: {
        code: 'BRANCH_INSPECT_FAILED',
        message: errorMessage,
        details: { branchId },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

async function fetchBranchForRepo(client: AgorClient, repoId: string, branchId: string) {
  const branch = await client.service('branches').get(branchId);
  if (!branch?.path) {
    throw new Error(`Branch ${branchId} has no path`);
  }
  if (branch.repo_id !== repoId) {
    throw new Error(`Branch ${branchId} does not belong to repo ${repoId}`);
  }
  return branch;
}

interface BranchPathRecord {
  repo_id?: string;
  path?: string;
}

async function fetchAllBranchesForRepo(
  client: AgorClient,
  repoId: string
): Promise<BranchPathRecord[]> {
  const branches: BranchPathRecord[] = [];
  const limit = 1000;
  let skip = 0;

  while (true) {
    const result = await client.service('branches').find({
      query: { repo_id: repoId, $limit: limit, $skip: skip },
    });
    const page = (Array.isArray(result) ? result : result.data) as BranchPathRecord[];
    branches.push(...page);

    if (Array.isArray(result)) break;
    if (page.length === 0 || branches.length >= result.total) break;

    skip += page.length;
  }

  return branches;
}

async function addSafeDirectoryForCurrentUser(pathToTrust: string): Promise<void> {
  try {
    const { git } = createGit();
    await git.addConfig('safe.directory', pathToTrust, true, 'global');
  } catch (error) {
    console.warn(
      `[branch.inspect] Failed to add safe.directory for ${pathToTrust}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function prepareBranchInspectionGitConfig(
  client: AgorClient,
  branch: { path: string; repo_id?: string }
): Promise<{ local_path?: string } | null> {
  await addSafeDirectoryForCurrentUser(branch.path);

  if (!branch.repo_id) return null;
  try {
    const repo = await client.service('repos').get(branch.repo_id);
    if (repo?.local_path) {
      await addSafeDirectoryForCurrentUser(repo.local_path);
    }
    return repo ?? null;
  } catch (error) {
    console.warn(
      `[branch.inspect] Failed to load repo ${branch.repo_id} for safe.directory setup:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

async function readBranchInspectState({
  branchPath,
  repoPath,
  fallbackRef,
  logPrefix,
}: {
  branchPath: string;
  repoPath?: string;
  fallbackRef: string;
  logPrefix: string;
}): Promise<{ currentSha: string; currentRef: string }> {
  const { git } = createGit(branchPath);
  const safeArgs = [
    '-c',
    `safe.directory=${branchPath}`,
    ...(repoPath ? ['-c', `safe.directory=${repoPath}`] : []),
  ];

  let currentSha = 'unknown';
  try {
    currentSha = (await git.raw([...safeArgs, 'rev-parse', 'HEAD'])).trim() || 'unknown';
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to read HEAD SHA; returning currentSha=unknown:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  if (currentSha !== 'unknown') {
    try {
      const status = await git.raw([...safeArgs, 'status', '--porcelain']);
      if (status.trim().length > 0) currentSha = `${currentSha}-dirty`;
    } catch (error) {
      console.warn(
        `${logPrefix} Failed to read dirty state; returning clean SHA:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  let currentRef = fallbackRef;
  try {
    currentRef =
      (await git.raw([...safeArgs, 'rev-parse', '--abbrev-ref', 'HEAD'])).trim() || currentRef;
  } catch (error) {
    console.warn(
      `${logPrefix} Failed to read current branch; falling back to DB branch name:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  return { currentSha, currentRef };
}

/**
 * Handle branch.agor-yml.import command.
 * Reads branch-scoped .agor.yml from a managed checkout.
 */
export async function handleBranchAgorYmlImport(
  payload: BranchAgorYmlImportPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { repoId, branchId } = payload.params;

  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'branch.agor-yml.import', repoId, branchId },
    };
  }

  let client: AgorClient | null = null;
  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    const branch = await fetchBranchForRepo(client, repoId, branchId);
    const agorYmlPath = join(branch.path, '.agor.yml');
    const environment = parseAgorYml(agorYmlPath);

    return { success: true, data: { repoId, branchId, environment } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[branch.agor-yml.import] Failed:', errorMessage);
    return {
      success: false,
      error: {
        code: 'BRANCH_AGOR_YML_IMPORT_FAILED',
        message: errorMessage,
        details: { repoId, branchId },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle branch.agor-yml.export command.
 * Writes environment config to branch-scoped .agor.yml in a managed checkout.
 */
export async function handleBranchAgorYmlExport(
  payload: BranchAgorYmlExportPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { repoId, branchId, environment } = payload.params;

  if (options.dryRun) {
    return {
      success: true,
      data: { dryRun: true, command: 'branch.agor-yml.export', repoId, branchId },
    };
  }

  let client: AgorClient | null = null;
  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    const branch = await fetchBranchForRepo(client, repoId, branchId);
    const agorYmlPath = join(branch.path, '.agor.yml');
    writeAgorYml(agorYmlPath, environment as Parameters<typeof writeAgorYml>[1]);

    return { success: true, data: { repoId, branchId, path: agorYmlPath } };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[branch.agor-yml.export] Failed:', errorMessage);
    return {
      success: false,
      error: {
        code: 'BRANCH_AGOR_YML_EXPORT_FAILED',
        message: errorMessage,
        details: { repoId, branchId },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.repo.realign-origin command.
 * Ensures the on-disk remote.origin.url matches the DB's canonical remote_url.
 */
export async function handleGitRepoRealignOrigin(
  payload: GitRepoRealignOriginPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const repoId = payload.params.repoId;

  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.repo.realign-origin',
        repoId,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);

    const repo = await client.service('repos').get(repoId);
    if (repo.repo_type !== 'remote' || !repo.remote_url || !repo.local_path) {
      return { success: true, data: { repoId, changed: false, skipped: true } };
    }

    const result = await ensureGitRemoteUrl(repo.local_path, 'origin', repo.remote_url);
    if (result.changed) {
      const { redactUrlUserinfo } = await import('@agor/core/config');
      console.warn(
        `[SECURITY] Realigned remote.origin.url for repo ${repo.repo_id} (slug=${repo.slug}); ` +
          `canonical URL now: ${redactUrlUserinfo(repo.remote_url)}`
      );
    }

    return {
      success: true,
      data: {
        repoId,
        changed: result.changed,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.repo.realign-origin] Failed:', errorMessage);
    return {
      success: false,
      error: {
        code: 'GIT_REPO_REALIGN_ORIGIN_FAILED',
        message: errorMessage,
        details: { repoId },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.repo.delete command.
 * Removes managed branch directories first, then the managed repo directory.
 */
export async function handleGitRepoDelete(
  payload: GitRepoDeletePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const { repoId } = payload.params;

  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.repo.delete',
        repoId,
      },
    };
  }

  let client: AgorClient | null = null;
  const deletedPaths: string[] = [];
  let repoPath: string | undefined;

  try {
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);

    const repo = await client.service('repos').get(repoId);
    repoPath = repo.local_path;
    if (!repoPath) {
      throw new Error(`Repo ${repoId} has no local_path`);
    }

    const branches = await fetchAllBranchesForRepo(client, repoId);

    const foreignBranches = branches.filter((branch) => branch.repo_id !== repoId);
    if (foreignBranches.length > 0) {
      throw new Error(
        `SAFETY CHECK FAILED: Found ${foreignBranches.length} branch(es) not belonging to repo ${repoId}`
      );
    }

    for (const branch of branches) {
      if (!branch.path) continue;
      await deleteBranchDirectory(branch.path);
      deletedPaths.push(branch.path);
      console.log(`🗑️  [git.repo.delete] Deleted branch directory: ${branch.path}`);
    }

    await deleteRepoDirectory(repoPath);
    deletedPaths.push(repoPath);
    console.log(`🗑️  [git.repo.delete] Deleted repository directory: ${repoPath}`);

    return {
      success: true,
      data: {
        repoId,
        deletedPaths,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.repo.delete] Failed:', errorMessage);
    return {
      success: false,
      error: {
        code: 'GIT_REPO_DELETE_FAILED',
        message: errorMessage,
        details: {
          repoId,
          repoPath,
          deletedPaths,
        },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.clone command
 *
 * Clones a repository to the local filesystem and creates the database record.
 * This is a complete transaction - filesystem + DB in one atomic operation.
 */
export async function handleGitClone(
  payload: GitClonePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const createDbRecord = payload.params.createDbRecord ?? true;
  const safeCloneUrl = stripGitUrlCredentials(payload.params.url);

  // Dry run mode - just validate and return
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.clone',
        url: safeCloneUrl,
        outputPath: payload.params.outputPath,
        branch: payload.params.branch,
        bare: payload.params.bare,
        // Surface user-pinned default_branch in the dry-run trace so callers
        // (and tests) can verify the field threaded through from the schema.
        default_branch: payload.params.default_branch,
        createDbRecord,
      },
    };
  }

  const cloneOutputPath =
    payload.params.outputPath ??
    (payload.params.slug ? join(getReposDir(), payload.params.slug) : undefined);

  let client: AgorClient | null = null;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.clone] Connected to daemon');

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client, payload.params.userId);
    if (Object.keys(env).length > 0) {
      console.log('[git.clone] Resolved credentials:', Object.keys(env));
    }

    // Determine output path. Prefer the daemon-supplied path; otherwise use
    // the Agor slug when present so same-basename remotes do not collide.
    const reposDir = getReposDir();
    const outputPath = cloneOutputPath;

    // Clone the repository. If the caller pinned a default_branch, forward
    // it as `branch` so the working tree lands on that branch — otherwise
    // `.agor.yml` on a non-default branch wouldn't be visible at parse time
    // below.
    const pinnedBranch = payload.params.default_branch?.trim() || undefined;
    console.log(
      `[git.clone] Cloning ${redactGitUrlCredentials(safeCloneUrl)} to ${outputPath || reposDir}` +
        (pinnedBranch ? ` (branch: ${pinnedBranch})` : '') +
        '...'
    );
    const cloneResult = await cloneRepo({
      url: safeCloneUrl,
      targetDir: outputPath, // undefined = let cloneRepo compute path
      bare: payload.params.bare,
      branch: pinnedBranch,
      env,
    });

    console.log(`[git.clone] Clone successful: ${cloneResult.path}`);

    // Compute slug for the repo
    const slug = payload.params.slug || computeRepoSlug(safeCloneUrl);
    const repoName = extractRepoName(slug);

    // Create DB record if requested (default: true)
    let repoId: string | undefined;
    let unixGroup: string | undefined;

    if (createDbRecord) {
      // Parse .agor.yml for environment config (if present). Returns v2
      // RepoEnvironment; legacy v1 files are wrapped as variants.default.
      const agorYmlPath = join(cloneResult.path, '.agor.yml');
      let environment: import('@agor/core/types').RepoEnvironment | null = null;

      try {
        const parsed = parseAgorYml(agorYmlPath);
        if (parsed) {
          environment = parsed;
          console.log(`[git.clone] Loaded environment config from .agor.yml`);
        }
      } catch (error) {
        console.warn(
          `[git.clone] Failed to parse .agor.yml:`,
          error instanceof Error ? error.message : String(error)
        );
      }

      // User-supplied default_branch wins over the auto-detected origin/HEAD.
      // Only fall back to the auto-detected value when the caller didn't
      // pin one. This is what makes "Add Repository → Default Branch =
      // some-feature-branch" actually persist into the DB record instead
      // of being silently overwritten by whatever GitHub's HEAD points at.
      const defaultBranch = payload.params.default_branch?.trim() || cloneResult.defaultBranch;

      if (payload.params.repoId) {
        // Daemon pre-created the row in `cloneRepository` so failures stay
        // queryable. Patch it to `ready` and fill in the post-clone fields.
        repoId = payload.params.repoId;
        console.log(
          `[git.clone] Patching pre-created repo ${shortId(repoId)} to ready: ` +
            `slug=${slug} default_branch=${defaultBranch}` +
            (payload.params.default_branch ? ' (user-supplied)' : ' (auto-detected)')
        );
        await client.service('repos').patch(repoId, {
          name: repoName,
          local_path: cloneResult.path,
          default_branch: defaultBranch,
          clone_status: 'ready',
          // Explicit null clears any prior `clone_error` (e.g. from a retry
          // through the daemon's failed-row replace path). `deepMerge` in
          // `RepoRepository.update` propagates the null; `repoToInsert`
          // coerces it back to `undefined` so the stored shape stays
          // aligned with the `clone_error?: RepoCloneError` invariant.
          // Cast: Feathers' patch typing is `Partial<Repo>`, which forbids
          // null on optional fields even when the merger explicitly handles it.
          clone_error: null as unknown as undefined,
          ...(environment ? { environment } : {}),
        });
      } else {
        // Legacy fallback (no pre-created row): create the record now. Used
        // when a caller invokes the executor directly without going through
        // `reposService.cloneRepository` (e.g. ad-hoc tooling).
        console.log(
          `[git.clone] Creating repo record: slug=${slug} default_branch=${defaultBranch}` +
            (payload.params.default_branch ? ' (user-supplied)' : ' (auto-detected)')
        );
        const repoRecord = await client.service('repos').create({
          repo_type: 'remote',
          slug,
          name: repoName,
          remote_url: safeCloneUrl,
          local_path: cloneResult.path,
          default_branch: defaultBranch,
          clone_status: 'ready',
          ...(environment ? { environment } : {}),
        });
        repoId = repoRecord.repo_id;
        console.log(`[git.clone] Repo record created: ${repoId}`);
      }

      // Initialize Unix group for repo isolation via daemon RPC (if requested).
      // Runs daemon-side so that groupadd/chgrp/setfacl execute with daemon
      // sudo privileges regardless of executor impersonation mode.
      if (payload.params.initUnixGroup && repoId) {
        try {
          console.log(`[git.clone] Initializing Unix group for repo ${shortId(repoId)}`);
          const result = await client
            .service('repos')
            .initializeUnixGroup({ repoId, userId: payload.params.userId });
          unixGroup = result.unixGroup;
          console.log(`[git.clone] Unix group initialized: ${unixGroup}`);
        } catch (error) {
          // Log but don't fail the entire operation
          console.error(
            `[git.clone] Failed to initialize Unix group:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }

    return {
      success: true,
      data: {
        path: cloneResult.path,
        repoName: cloneResult.repoName,
        defaultBranch: cloneResult.defaultBranch,
        slug,
        repoId,
        dbRecordCreated: createDbRecord,
        unixGroup,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.clone] Failed:', errorMessage);

    // Persist failure on the pre-created repo row so MCP / REST callers can
    // discover the outcome via `agor_repos_get(repoId)` instead of polling
    // `agor_repos_list` forever for a row that will never appear. The daemon
    // also broadcasts WebSocket `repo:cloneError` independently — this row
    // is the durable record for clients that connect later.
    if (payload.params.repoId && client) {
      try {
        const category = categorizeGitError(errorMessage);
        const firstLine = errorMessage.split('\n')[0]?.slice(0, 500) || errorMessage.slice(0, 500);
        await client.service('repos').patch(payload.params.repoId, {
          clone_status: 'failed',
          clone_error: {
            // simple-git wraps git's exit code in the message rather than
            // surfacing it as a numeric field; default to 1 since the
            // underlying call already failed.
            exit_code: 1,
            category,
            message: firstLine,
          },
        });
        console.log(
          `[git.clone] Marked repo ${shortId(payload.params.repoId)} as failed (${category})`
        );
      } catch (patchError) {
        // Best-effort: if the daemon-side patch fails, the daemon's `onExit`
        // handler in `cloneRepository` is the safety net (it patches based on
        // exit code alone) — log and move on.
        console.error(
          '[git.clone] Failed to mark repo as failed:',
          patchError instanceof Error ? patchError.message : String(patchError)
        );
      }
    }

    return {
      success: false,
      error: {
        code: 'GIT_CLONE_FAILED',
        message: errorMessage,
        details: {
          url: safeCloneUrl,
          outputPath: cloneOutputPath,
        },
      },
    };
  } finally {
    // Disconnect from daemon
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Render environment command templates with full context including GID
 *
 * Fetches branch and repo from database, gets GID from Unix group (if available),
 * and renders all environment templates with complete context.
 *
 * @param client - Feathers client
 * @param branchId - Branch ID
 * @param repoId - Repo ID
 * @param unixGroup - Unix group name (to look up GID), undefined if RBAC disabled
 * @param configuredHostIp - Host IP override from daemon-resolved config (config.daemon.host_ip_address)
 * @returns Rendered template fields
 */
async function renderEnvironmentTemplates(
  client: AgorClient,
  branchId: string,
  repoId: string,
  unixGroup: string | undefined,
  configuredHostIp: string | undefined
): Promise<{
  start_command?: string;
  stop_command?: string;
  nuke_command?: string;
  health_check_url?: string;
  app_url?: string;
  logs_command?: string;
  environment_variant?: string;
}> {
  // Import dependencies dynamically
  const { renderBranchSnapshot } = await import('@agor/core/environment/render-snapshot');
  const { getGidFromGroupName } = await import('@agor/core/unix');
  const { resolveHostIpAddress } = await import('@agor/core/utils/host-ip');

  // Fetch branch and repo from database
  const branch = await client.service('branches').get(branchId);
  const repo = await client.service('repos').get(repoId);

  // v2 environment is the source of truth; `environment_config` is a derived
  // legacy view. If neither is present, nothing to render.
  if (!repo.environment) {
    return {};
  }

  // Look up GID from Unix group (only if group was created)
  const unixGid = unixGroup ? getGidFromGroupName(unixGroup) : undefined;

  // Resolve host IP for {{host.ip_address}} (frozen into rendered commands).
  // Override comes from daemon-resolved config slice; autodetected fallback
  // happens inside resolveHostIpAddress when undefined.
  const hostIpAddress = resolveHostIpAddress(configuredHostIp);

  // Honor an explicit variant override if the branch already picked one;
  // otherwise fall through to `environment.default` inside renderBranchSnapshot.
  let snapshot: ReturnType<typeof renderBranchSnapshot>;
  try {
    snapshot = renderBranchSnapshot(
      { slug: repo.slug, environment: repo.environment },
      {
        branch_unique_id: branch.branch_unique_id,
        name: branch.name,
        path: branch.path,
        custom_context: branch.custom_context,
        unix_gid: unixGid,
        host_ip_address: hostIpAddress,
        base_ref: branch.base_ref,
        ref_type: branch.ref_type,
      },
      branch.environment_variant
    );
  } catch (err) {
    console.warn(
      `[renderEnvironmentTemplates] Failed to render environment for ${branch.name}:`,
      err
    );
    return {};
  }
  if (!snapshot) return {};

  return {
    start_command: snapshot.start || undefined,
    stop_command: snapshot.stop || undefined,
    nuke_command: snapshot.nuke,
    health_check_url: snapshot.health,
    app_url: snapshot.app,
    logs_command: snapshot.logs,
    environment_variant: snapshot.variant,
  };
}

/**
 * Handle git.branch.add command
 *
 * Creates a git branch at the specified path.
 * The DB record is created by the daemon BEFORE this runs (with filesystem_status: 'creating').
 * This handler patches the branch to 'ready' when complete (or leaves as 'creating' on failure).
 */
export async function handleGitBranchAdd(
  payload: GitBranchAddPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const branchId = payload.params.branchId;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.branch.add',
        branchId,
        repoId: payload.params.repoId,
        repoPath: payload.params.repoPath,
        branchName: payload.params.branchName,
        branchPath: payload.params.branchPath,
        branch: payload.params.branch,
        sourceBranch: payload.params.sourceBranch,
        createBranch: payload.params.createBranch,
        storageMode: payload.params.storageMode,
        cloneDepth: payload.params.cloneDepth,
        remoteUrl: payload.params.remoteUrl
          ? stripGitUrlCredentials(payload.params.remoteUrl)
          : payload.params.remoteUrl,
        referencePath: payload.params.referencePath,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.branch.add] Connected to daemon');

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client, payload.params.userId);

    // Get parameters
    const repoId = payload.params.repoId;
    const branchPath = payload.params.branchPath;
    const repoPath = payload.params.repoPath;
    const branchName = payload.params.branchName;
    const branch = payload.params.branch || branchName;
    const shouldCreateBranch = payload.params.createBranch ?? false;
    const sourceBranch = payload.params.sourceBranch;
    const refType = payload.params.refType;
    const restoreMode = payload.params.restoreMode ?? false;
    const storageMode = payload.params.storageMode ?? 'worktree';
    const cloneDepth = payload.params.cloneDepth;
    const remoteUrl = payload.params.remoteUrl;
    const referencePath = payload.params.referencePath;

    console.log(`[git.branch.add] Creating branch at ${branchPath}...`);
    console.log(
      `[git.branch.add] Repo: ${repoPath}, Branch: ${branch}, CreateBranch: ${shouldCreateBranch}, RestoreMode: ${restoreMode}, RefType: ${refType || 'branch'}, StorageMode: ${storageMode}`
    );

    // Create the git branch on filesystem
    if (storageMode === 'clone') {
      // Self-standing clone path. The remote URL is daemon-resolved from the
      // repo record; refuse to silently fall through to worktree mode if it
      // didn't come along — that would defeat the leak-defense reason for
      // picking clone mode in the first place. (Belt + braces: the executor
      // payload schema also enforces this via superRefine.)
      if (!remoteUrl) {
        throw new Error(
          `storageMode='clone' requires remoteUrl in payload (got none). ` +
            `The daemon should forward repo.remote_url alongside storageMode.`
        );
      }

      // When creating a new branch, clone the source branch and have the
      // helper fork off the cloned tip. When checking out an existing
      // branch, just clone the ref directly. The helper owns both flows so
      // the executor handler doesn't have to orchestrate post-clone git ops.
      const cloneRef = shouldCreateBranch ? sourceBranch || branch : branch;
      console.log(
        `[git.branch.add] Using createBranchAsClone (remote=${redactGitUrlCredentials(remoteUrl)}, ` +
          `ref=${cloneRef}${shouldCreateBranch && branch !== cloneRef ? `, newBranch=${branch}` : ''}, ` +
          `depth=${cloneDepth ?? 'full'}, referenceHint=${referencePath ?? 'none'})`
      );
      await createBranchAsClone({
        remoteUrl,
        targetPath: branchPath,
        ref: cloneRef,
        ...(shouldCreateBranch && branch !== cloneRef ? { newBranchName: branch } : {}),
        depth: cloneDepth,
        // Pass the daemon's hint through unconditionally. The helper does
        // the existsSync check on the executor's filesystem and falls back
        // gracefully if the path isn't actually mounted here.
        ...(referencePath ? { referencePath } : {}),
        env,
      });
    } else if (restoreMode && sourceBranch) {
      // Restore mode: smart branch detection — checks if branch exists on remote,
      // falls back to creating from base ref if not. Safe because it only creates
      // a new branch when ls-remote confirms the branch doesn't exist anywhere.
      console.log(
        `[git.branch.add] Using restoreBranchFilesystem (branch: ${branch}, base: ${sourceBranch})`
      );
      const result = await restoreBranchFilesystem(repoPath, branchPath, branch, sourceBranch, env);
      if (!result.success) {
        throw new Error(`restoreBranchFilesystem failed: ${result.error}`);
      }
      console.log(`[git.branch.add] Restored branch via ${result.strategy} strategy`);
    } else {
      await createBranch(
        repoPath,
        branchPath,
        branch,
        shouldCreateBranch,
        true, // pullLatest
        sourceBranch,
        env,
        refType
      );
    }

    console.log(`[git.branch.add] Branch created at ${branchPath}`);

    // Initialize Unix group for branch isolation via daemon RPC (if requested).
    // Runs daemon-side so that groupadd/chgrp/setfacl execute with daemon
    // sudo privileges regardless of executor impersonation mode.
    let unixGroup: string | undefined;
    if (payload.params.initUnixGroup && branchId) {
      try {
        const othersAccess = payload.params.othersAccess || 'read';
        console.log(`[git.branch.add] Initializing Unix group for branch ${shortId(branchId)}`);
        const result = await client
          .service('branches')
          .initializeUnixGroup({ branchId, othersAccess });
        unixGroup = result.unixGroup;
        console.log(`[git.branch.add] Unix group initialized: ${unixGroup}`);
      } catch (error) {
        // Log but don't fail the entire operation
        console.error(
          `[git.branch.add] Failed to initialize Unix group:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    } else if (!payload.params.initUnixGroup && storageMode === 'worktree') {
      // RBAC is explicitly disabled — set basic permissions for the base
      // repo's .git/worktrees/<name>/ entry so git operations work even
      // without Unix group isolation.
      //
      // Clone-mode skips this: there's no `.git/worktrees/<name>/` entry in
      // any base repo (the working tree owns its own `.git/` directory),
      // so running this would log a bogus failure on every clone-mode
      // create. The clone's `.git/` is set up by `git clone` itself.
      try {
        console.log(
          `[git.branch.add] RBAC disabled, setting basic permissions for .git/worktrees/${branchName}`
        );
        await fixBranchGitDirPermissionsBasic(repoPath, branchName);
      } catch (error) {
        console.error(
          `[git.branch.add] Failed to set basic .git/worktrees permissions:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    // else: initUnixGroup is true but branchId is missing - skip both paths (this shouldn't happen)

    // Render environment command templates (after Unix group creation if applicable)
    // Templates should be rendered regardless of RBAC status, but GID will only be available
    // when Unix groups are enabled
    let renderedTemplates:
      | {
          start_command?: string;
          stop_command?: string;
          nuke_command?: string;
          health_check_url?: string;
          app_url?: string;
          logs_command?: string;
        }
      | undefined;

    if (branchId) {
      try {
        const logSuffix = unixGroup
          ? `with GID for branch ${shortId(branchId)}`
          : `for branch ${shortId(branchId)} (no Unix group)`;
        console.log(`[git.branch.add] Rendering environment templates ${logSuffix}`);
        renderedTemplates = await renderEnvironmentTemplates(
          client,
          branchId,
          repoId,
          unixGroup,
          payload.resolvedConfig?.daemon?.host_ip_address
        );
        console.log(`[git.branch.add] Templates rendered successfully`);
      } catch (error) {
        console.error(
          `[git.branch.add] Failed to render templates:`,
          error instanceof Error ? error.message : String(error)
        );
        // Don't fail the entire operation if template rendering fails
      }
    }

    // Patch branch status to 'ready' (DB record was created by daemon with 'creating')
    if (branchId) {
      console.log(`[git.branch.add] Marking branch ${shortId(branchId)} as ready`);
      await client.service('branches').patch(branchId, {
        filesystem_status: 'ready',
        ...(unixGroup ? { unix_group: unixGroup } : {}),
        ...(renderedTemplates || {}),
      });
      console.log(`[git.branch.add] Branch marked as ready`);
    }

    return {
      success: true,
      data: {
        branchPath,
        branchName,
        branch,
        repoPath,
        repoId,
        branchId,
        unixGroup,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.branch.add] Failed:', errorMessage);

    // Fallback: ensure the directory exists with correct perms/ACLs even when
    // git worktree add fails (e.g., branch deleted during archive). This
    // unblocks sync-unix, sessions, and manual recovery — the directory just
    // won't be a proper git branch. Also repairs perms if a prior attempt
    // created the dir but failed on group initialization.
    const fallbackPath = payload.params.branchPath;
    let fallbackCreated = false;
    let fallbackPermissionsApplied = false;
    if (fallbackPath) {
      // Step 1: Ensure directory exists
      if (!existsSync(fallbackPath)) {
        try {
          mkdirSync(fallbackPath, { recursive: true });
          console.log(`[git.branch.add] Fallback: created empty directory ${fallbackPath}`);
          fallbackCreated = true;
        } catch (mkdirError) {
          console.error(
            '[git.branch.add] Fallback: failed to create directory:',
            mkdirError instanceof Error ? mkdirError.message : String(mkdirError)
          );
        }
      }

      // Step 2: Apply perms/ACLs via daemon RPC (runs even if dir already existed from a prior attempt)
      if (existsSync(fallbackPath) && payload.params.initUnixGroup && branchId && client) {
        try {
          const othersAccess = payload.params.othersAccess || 'read';
          await client.service('branches').initializeUnixGroup({ branchId, othersAccess });
          console.log(`[git.branch.add] Fallback: applied Unix group permissions`);
          fallbackPermissionsApplied = true;
        } catch (permError) {
          console.error(
            '[git.branch.add] Fallback: failed to set Unix group permissions:',
            permError instanceof Error ? permError.message : String(permError)
          );
        }
      }
    }

    // Provide user-friendly error messages for common failures
    let userMessage = errorMessage;
    if (errorMessage.includes('already exists')) {
      if (errorMessage.includes('branch')) {
        userMessage = `A branch named '${payload.params.branch || payload.params.branchName}' already exists and is in use by another branch. Please choose a different name.`;
      } else {
        userMessage = `Directory '${payload.params.branchPath || payload.params.branchName}' already exists. An archived or partially-cleaned branch may still occupy this path.`;
      }
    }

    // Try to mark branch as failed with error details (if we have a branchId and client)
    if (branchId && client) {
      try {
        await client.service('branches').patch(branchId, {
          filesystem_status: 'failed',
          error_message: userMessage,
        });
        console.log(`[git.branch.add] Marked branch as failed`);
      } catch (patchError) {
        console.error(
          '[git.branch.add] Failed to mark branch as failed:',
          patchError instanceof Error ? patchError.message : String(patchError)
        );
      }
    }

    return {
      success: false,
      error: {
        code: 'GIT_BRANCH_ADD_FAILED',
        message: userMessage,
        details: {
          branchId,
          repoId: payload.params.repoId,
          repoPath: payload.params.repoPath,
          branchName: payload.params.branchName,
          branchPath: payload.params.branchPath,
          fallbackDirectoryCreated: fallbackCreated,
          fallbackPermissionsApplied,
        },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.branch.remove command
 *
 * Removes a branch from the filesystem and deletes the database record.
 * This is a complete transaction - filesystem + DB in one atomic operation.
 */
export async function handleGitBranchRemove(
  payload: GitBranchRemovePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  const deleteDbRecord = payload.params.deleteDbRecord ?? true;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.branch.remove',
        branchId: payload.params.branchId,
        branchPath: payload.params.branchPath,
        force: payload.params.force,
        deleteDbRecord,
        storageMode: payload.params.storageMode,
      },
    };
  }

  let client: AgorClient | null = null;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.branch.remove] Connected to daemon');

    const branchId = payload.params.branchId;
    const branchPath = payload.params.branchPath;
    const storageMode = payload.params.storageMode ?? 'worktree';

    console.log(
      `[git.branch.remove] Removing branch at ${branchPath} (storageMode=${storageMode})...`
    );

    // Find the repo path from the branch's .git file
    const { readFile, stat } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { join, dirname, basename } = await import('node:path');

    const gitPath = join(branchPath, '.git');
    let filesystemRemoved = false;

    // Clone-mode short-circuit: there's no parent base repo to deregister
    // from, no `gitdir:` pointer file, and `git worktree remove --force`
    // would fail (or worse, mis-target). Just blow away the directory.
    if (storageMode === 'clone') {
      if (existsSync(branchPath)) {
        console.log(
          `[git.branch.remove] Clone mode — removing self-standing directory ${branchPath}`
        );
        await deleteBranchDirectory(branchPath);
        filesystemRemoved = true;
      } else {
        console.log(
          '[git.branch.remove] Clone mode — directory already absent, skipping filesystem removal'
        );
      }
    } else if (existsSync(gitPath)) {
      // Worktree mode: .git is a file (`gitdir: …`) pointing back at the
      // base repo's `.git/worktrees/<name>`. Read it to find the base repo
      // and deregister cleanly.
      //
      // Defensive: if .git is somehow a directory here despite storage_mode
      // being 'worktree' (mislabeled DB row from a manual conversion), fall
      // back to the clone-mode removal path rather than misreading a dir as
      // a `gitdir:` file. See design doc §2 operational caveats.
      const gitStat = await stat(gitPath);
      if (gitStat.isDirectory()) {
        console.warn(
          `[git.branch.remove] DB says storage_mode='worktree' but ${gitPath} is a directory — treating as clone-mode removal`
        );
        await deleteBranchDirectory(branchPath);
        filesystemRemoved = true;
      } else {
        // Read .git file to find the main repo
        // Format: gitdir: /path/to/repo/.git/worktrees/<name>
        const gitContent = await readFile(gitPath, 'utf-8');
        const match = gitContent.match(/gitdir:\s*(.+)/);

        if (!match) {
          throw new Error(`Invalid .git file in branch: ${gitPath}`);
        }

        // Extract repo path from gitdir path
        // gitdir points to: <repo>/.git/worktrees/<name>
        // We need: <repo>
        const gitdirPath = match[1].trim();
        const gitBranchesDir = dirname(gitdirPath); // <repo>/.git/worktrees
        const dotGitDir = dirname(gitBranchesDir); // <repo>/.git
        const repoPath = dirname(dotGitDir); // <repo>

        const branchName = basename(branchPath);

        console.log(`[git.branch.remove] Repo path: ${repoPath}, Branch name: ${branchName}`);

        // Deregister the git worktree (removes the `.git/worktrees/<name>/`
        // entry from the base repo). Wraps `git worktree remove --force`.
        await removeGitWorktree(repoPath, branchName);
        console.log(`[git.branch.remove] Git worktree deregistered`);

        // git worktree remove --force may leave residual files on disk.
        // Fully delete the directory to reclaim all disk space.
        if (existsSync(branchPath)) {
          console.log(`[git.branch.remove] Directory still exists, removing residual files...`);
          await deleteBranchDirectory(branchPath);
          console.log(`[git.branch.remove] Directory fully removed`);
        }

        filesystemRemoved = true;
        console.log(`[git.branch.remove] Branch removed from filesystem`);

        // Delete the associated branch if requested
        if (payload.params.deleteBranch && payload.params.branch) {
          const branchToDelete = payload.params.branch;
          try {
            console.log(`[git.branch.remove] Deleting branch '${branchToDelete}'...`);
            const deleted = await deleteBranch(repoPath, branchToDelete);
            if (deleted) {
              console.log(`[git.branch.remove] Branch '${branchToDelete}' deleted`);
            } else {
              console.log(
                `[git.branch.remove] Branch '${branchToDelete}' not found (already deleted)`
              );
            }
          } catch (branchError) {
            // Log but don't fail the overall operation
            console.warn(
              `[git.branch.remove] Failed to delete branch '${branchToDelete}':`,
              branchError instanceof Error ? branchError.message : String(branchError)
            );
          }
        }
      }
    } else if (existsSync(branchPath)) {
      // No .git file but directory exists — orphaned directory from a previous partial removal.
      // Clean it up completely.
      console.log(
        '[git.branch.remove] No .git file but directory exists (orphaned), removing directory...'
      );
      await deleteBranchDirectory(branchPath);
      filesystemRemoved = true;
      console.log('[git.branch.remove] Orphaned directory removed');
    } else {
      console.log('[git.branch.remove] Branch does not exist on filesystem, skipping git removal');
    }

    // Delete DB record if requested (default: true)
    let dbRecordDeleted = false;

    if (deleteDbRecord) {
      console.log(`[git.branch.remove] Deleting branch record: ${branchId}`);

      // Delete branch via Feathers service
      // The daemon's branches service handles cascades and hooks
      await client.service('branches').remove(branchId);
      dbRecordDeleted = true;

      console.log(`[git.branch.remove] Branch record deleted`);
    }

    return {
      success: true,
      data: {
        branchId,
        branchPath,
        filesystemRemoved,
        dbRecordDeleted,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.branch.remove] Failed:', errorMessage);

    return {
      success: false,
      error: {
        code: 'GIT_BRANCH_REMOVE_FAILED',
        message: errorMessage,
        details: {
          branchId: payload.params.branchId,
          branchPath: payload.params.branchPath,
        },
      },
    };
  } finally {
    if (client) {
      try {
        client.io.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}

/**
 * Handle git.branch.clean command
 *
 * Removes untracked files and build artifacts from the branch.
 * Uses `git clean -fdx` which removes untracked files, directories,
 * and ignored files (node_modules, build artifacts, etc.)
 */
export async function handleGitBranchClean(
  payload: GitBranchCleanPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.branch.clean',
        branchPath: payload.params.branchPath,
      },
    };
  }

  try {
    const branchPath = payload.params.branchPath;

    console.log(`[git.branch.clean] Cleaning branch at ${branchPath}...`);

    // Clean the branch
    const result = await cleanBranch(branchPath);

    console.log(`[git.branch.clean] Cleaned ${result.filesRemoved} files from ${branchPath}`);

    return {
      success: true,
      data: {
        branchPath,
        filesRemoved: result.filesRemoved,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.branch.clean] Failed:', errorMessage);

    return {
      success: false,
      error: {
        code: 'GIT_BRANCH_CLEAN_FAILED',
        message: errorMessage,
        details: {
          branchPath: payload.params.branchPath,
        },
      },
    };
  }
}
