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
 * 3. Privileged Unix group/ACL setup runs in this same tenant-mounted Git
 *    lifecycle executor, before the resource is marked ready. This avoids a
 *    nested executor-capacity dependency while keeping tenant paths out of the
 *    daemon process.
 *
 * Feathers hooks handle WebSocket broadcasts automatically when records are created/updated.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { realpath as fsRealpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, sep as pathSeparator, relative, resolve } from 'node:path';
import { getReposDir, isValidManagedRepoSlug, isValidSlug } from '@agor/core/config';
import { parseAgorYml, writeAgorYml } from '@agor/core/config/node';
import { shortId } from '@agor/core/db';
import { type BranchID, isValidManagedBranchName, type Repo } from '@agor/core/types';
import { diagnoseGit } from '@agor/git';
import { appendGitConfigParameterPairs } from '../git/config-parameters.js';
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
  getDefaultBranch,
  getRemoteUrl,
  isValidGitRepo,
  listGitWorktrees,
  redactGitUrlCredentials,
  removeGitWorktree,
  restoreBranchFilesystem,
  scanGitConfigRemoteCredentials,
  scrubGitConfigRemoteCredentials,
  stripGitUrlCredentials,
} from '../git/index.js';
import type {
  BranchAgorYmlExportPayload,
  BranchAgorYmlImportPayload,
  BranchFilesListPayload,
  ExecutorResult,
  GitBranchAddPayload,
  GitBranchCleanPayload,
  GitBranchRemovePayload,
  GitClonePayload,
  GitManagedCredentialsReconcilePayload,
  GitRepoDeletePayload,
  GitRepoInspectPayload,
  GitRepoRealignOriginPayload,
} from '../payload-types.js';
import type { AgorClient } from '../services/feathers-client.js';
import {
  createExecutorClient,
  getExecutorBranchesService,
  getExecutorReposService,
} from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';
import {
  fixBranchGitDirPermissionsBasic,
  handleUnixSyncBranch,
  handleUnixSyncRepo,
} from './unix.js';

async function canonicalFilesystemIdentity(inputPath: string): Promise<string> {
  try {
    return await fsRealpath(inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(inputPath);
    throw error;
  }
}

function filesystemPathsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return (
      rel === '' || (rel !== '..' && !rel.startsWith(`..${pathSeparator}`) && !isAbsolute(rel))
    );
  };
  return contains(left, right) || contains(right, left);
}

/**
 * Self-hosted compatibility operation. The daemon authorizes the request and
 * launches this narrow inspection under the caller's resolved executor Unix
 * identity; the command deliberately has no daemon capability token.
 */
export async function handleGitRepoInspect(
  payload: GitRepoInspectPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  try {
    let inputPath = payload.params.path.trim();
    if (inputPath.startsWith('~')) {
      inputPath = join(userInfo().homedir, inputPath.slice(1).replace(/^[/\\]?/, ''));
    }
    if (!isAbsolute(inputPath)) throw new Error(`Path must be absolute: ${inputPath}`);
    const repoPath = await canonicalFilesystemIdentity(resolve(inputPath));
    if (!(await isValidGitRepo(repoPath))) {
      throw new Error(`Not a valid git repository: ${repoPath}`);
    }
    const remoteUrl = stripGitUrlCredentials((await getRemoteUrl(repoPath)) ?? '') || undefined;
    let environment: unknown;
    let environmentWarning: string | undefined;
    try {
      environment = parseAgorYml(join(repoPath, '.agor.yml')) ?? undefined;
    } catch {
      environmentWarning = 'Failed to parse .agor.yml; repository registration will continue.';
    }
    const scan = await scanGitConfigRemoteCredentials(repoPath);
    return {
      success: true,
      data: {
        path: repoPath,
        defaultBranch: await getDefaultBranch(repoPath),
        remoteUrl,
        environment,
        credentialFindingCount: scan.findings.length,
        ...(environmentWarning ? { environmentWarning } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'GIT_REPO_INSPECT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function handleGitManagedCredentialsReconcile(
  payload: GitManagedCredentialsReconcilePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  let client: AgorClient | null = null;
  try {
    client = await createExecutorClient(
      payload.daemonUrl || 'http://localhost:3030',
      payload.sessionToken
    );
    const fetchAll = async (service: 'repos' | 'branches', query: Record<string, unknown>) => {
      const rows: Array<{
        repo_id?: string;
        repo_type?: string;
        local_path?: string;
        path?: string;
      }> = [];
      while (true) {
        const result = await client!.service(service).find({
          query: { ...query, $limit: 1000, $skip: rows.length },
        });
        const page = Array.isArray(result) ? result : result.data;
        rows.push(...page);
        if (Array.isArray(result) || page.length === 0 || rows.length >= result.total) return rows;
      }
    };
    const repos = await fetchAll('repos', {});
    let findings = 0;
    for (const repo of repos.filter((item) => item.repo_type === 'remote')) {
      if (!options.dryRun && repo.local_path)
        findings += (await scrubGitConfigRemoteCredentials(repo.local_path)).findings.length;
      // Omitting `archived` intentionally returns both active and archived
      // branches. The public branch query contract accepts an exact boolean,
      // not a Feathers `$in` operator for this field.
      const branches = await fetchAll('branches', { repo_id: repo.repo_id });
      for (const branch of branches) {
        if (!options.dryRun && branch.path)
          findings += (await scrubGitConfigRemoteCredentials(branch.path)).findings.length;
      }
    }
    return { success: true, data: { findings, dryRun: options.dryRun === true } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'GIT_MANAGED_CREDENTIALS_RECONCILE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    client?.io.disconnect();
  }
}

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
  branch_id?: string;
  repo_id?: string;
  name?: string;
  path?: string;
}

async function fetchAllRepos(client: AgorClient): Promise<Repo[]> {
  const repos: Repo[] = [];
  const limit = 1000;
  let skip = 0;
  while (true) {
    const result = await client.service('repos').find({ query: { $limit: limit, $skip: skip } });
    const page = Array.isArray(result) ? result : result.data;
    repos.push(...page);
    if (Array.isArray(result) || page.length === 0 || repos.length >= result.total) return repos;
    skip += page.length;
  }
}

async function fetchAllBranchesForRepo(
  client: AgorClient,
  repoId?: string
): Promise<BranchPathRecord[]> {
  const branches: BranchPathRecord[] = [];
  const limit = 1000;
  let skip = 0;

  while (true) {
    const result = await client.service('branches').find({
      query: { ...(repoId ? { repo_id: repoId } : {}), $limit: limit, $skip: skip },
    });
    const page = (Array.isArray(result) ? result : result.data) as BranchPathRecord[];
    branches.push(...page);

    if (Array.isArray(result)) break;
    if (page.length === 0 || branches.length >= result.total) break;

    skip += page.length;
  }

  return branches;
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
    if (
      !repoPath ||
      repo.repo_type !== 'remote' ||
      !isValidManagedRepoSlug(repo.slug) ||
      repo.filesystem_status !== 'deleting' ||
      repo.filesystem_operation_id !== payload.params.filesystemOperationId
    ) {
      throw new Error(`SAFETY CHECK FAILED: Repo ${repoId} has no canonical managed identity`);
    }
    const managedRepoPath = repoPath;
    const allRepos = await fetchAllRepos(client);
    const canonicalManagedRepoPath = await canonicalFilesystemIdentity(managedRepoPath);
    const aliases: Repo[] = [];
    for (const candidate of allRepos) {
      if (candidate.repo_id === repo.repo_id) continue;
      const candidatePath = await canonicalFilesystemIdentity(candidate.local_path);
      if (filesystemPathsOverlap(canonicalManagedRepoPath, candidatePath)) aliases.push(candidate);
    }
    if (aliases.length > 0) {
      throw new Error('SAFETY CHECK FAILED: Repository root overlaps another metadata owner');
    }

    const branches = await fetchAllBranchesForRepo(client, repoId);
    const allBranches = await fetchAllBranchesForRepo(client);

    const foreignBranches = branches.filter((branch) => branch.repo_id !== repoId);
    if (foreignBranches.length > 0) {
      throw new Error(
        `SAFETY CHECK FAILED: Found ${foreignBranches.length} branch(es) not belonging to repo ${repoId}`
      );
    }

    // Resolve each identity once. Repository deletion may inventory thousands
    // of branches; resolving every candidate again for every target turns the
    // safety check into millions of filesystem syscalls and can time out a
    // valid cleanup before deletion even starts.
    const canonicalBranches: Array<{
      branchId: string | undefined;
      canonicalPath: string;
    }> = [];
    for (const candidate of allBranches) {
      if (!candidate.path) continue;
      canonicalBranches.push({
        branchId: candidate.branch_id,
        canonicalPath: await canonicalFilesystemIdentity(candidate.path),
      });
    }
    const otherRepoNamespaces: string[] = [];
    for (const candidateRepo of allRepos) {
      if (candidateRepo.repo_id === repoId || !isValidManagedRepoSlug(candidateRepo.slug)) {
        continue;
      }
      otherRepoNamespaces.push(
        await canonicalFilesystemIdentity(resolve(payload.params.branchesRoot, candidateRepo.slug))
      );
    }

    for (const branch of branches) {
      if (!branch.path) continue;
      if (!branch.branch_id || !isValidManagedBranchName(branch.name)) {
        throw new Error('SAFETY CHECK FAILED: Branch filesystem identity is incomplete');
      }
      const canonicalBranchPath =
        canonicalBranches.find((candidate) => candidate.branchId === branch.branch_id)
          ?.canonicalPath ?? (await canonicalFilesystemIdentity(branch.path));
      for (const candidate of canonicalBranches) {
        if (candidate.branchId === branch.branch_id) continue;
        if (filesystemPathsOverlap(canonicalBranchPath, candidate.canonicalPath)) {
          throw new Error('SAFETY CHECK FAILED: Branch root overlaps another metadata owner');
        }
      }
      for (const candidateNamespace of otherRepoNamespaces) {
        if (filesystemPathsOverlap(canonicalBranchPath, candidateNamespace)) {
          throw new Error(
            'SAFETY CHECK FAILED: Legacy branch root overlaps another repository namespace'
          );
        }
      }
      await deleteBranchDirectory(branch.path, payload.params.branchesRoot, {
        expectedRelativePath: join(repo.slug, branch.name),
      });
      deletedPaths.push(branch.path);
      console.log(`🗑️  [git.repo.delete] Deleted branch directory: ${branch.path}`);
    }

    await deleteRepoDirectory(repoPath, payload.params.reposRoot, {
      expectedRelativePath: repo.slug,
    });
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

    if (createDbRecord && !payload.params.repoId) {
      throw new Error(
        'Managed repository clones require a daemon-created repository identity before filesystem materialization'
      );
    }
    if (createDbRecord) {
      const persistedRepo = await client.service('repos').get(payload.params.repoId!);
      if (
        persistedRepo.repo_type !== 'remote' ||
        persistedRepo.slug !== payload.params.slug ||
        !cloneOutputPath ||
        resolve(persistedRepo.local_path) !== resolve(cloneOutputPath) ||
        !isValidSlug(persistedRepo.slug)
      ) {
        throw new Error('SAFETY CHECK FAILED: Repository filesystem identity is not canonical');
      }
    }

    // This check must run inside the executor, after impersonation/template
    // setup, because that is the process whose PATH and identity own the
    // actual clone. A CLI/daemon preflight can pass while this runtime cannot
    // resolve Git (for example, with a filtered PATH or remote executor).
    const git = await diagnoseGit();
    if (git.status !== 'ready') {
      throw new Error(git.detail ?? 'Git executable is unavailable.');
    }
    console.log(`[git.clone] Git ${git.version} is executable (${git.binary})`);

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client, payload.params.userId);
    if (Object.keys(env).length > 0) {
      console.log('[git.clone] Resolved credentials:', Object.keys(env));
    }

    // Determine output path. Prefer the daemon-supplied path; otherwise use
    // the Agor slug when present so same-basename remotes do not collide.
    const reposDir = getReposDir();
    const outputPath = cloneOutputPath;

    // The daemon selects this canonical, tenant-scoped destination. Trust only
    // that exact path for this one-purpose executor process so an existing
    // daemon-owned clone can be inspected/reused under Unix impersonation.
    if (outputPath) {
      appendGitConfigParameterPairs([`safe.directory=${outputPath}`]);
    }

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
      targetDir: outputPath ?? join(reposDir, extractRepoName(safeCloneUrl)),
      bare: payload.params.bare,
      branch: pinnedBranch,
      env,
    });

    console.log(`[git.clone] Clone successful: ${cloneResult.path}`);

    if (outputPath && resolve(cloneResult.path) !== resolve(outputPath)) {
      throw new Error('SAFETY CHECK FAILED: Clone result escaped the canonical repository root');
    }

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
        // queryable. Fill post-clone fields but keep it `cloning` until the
        // synchronous operator permission handoff below completes.
        repoId = payload.params.repoId;
        console.log(
          `[git.clone] Patching pre-created repo ${shortId(repoId)} with cloned metadata: ` +
            `slug=${slug} default_branch=${defaultBranch}` +
            (payload.params.default_branch ? ' (user-supplied)' : ' (auto-detected)')
        );
        await getExecutorReposService(client).patch(repoId, {
          name: repoName,
          default_branch: defaultBranch,
          clone_status: 'cloning',
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
      }

      // Apply Unix isolation in this tenant-mounted lifecycle executor. Do not
      // dispatch a nested executor: bounded hosted pools can deadlock when all
      // outer Git jobs wait for inner permission jobs. Isolation is required
      // in insulated/strict mode, so failure must prevent `ready`.
      if (payload.params.initUnixGroup && repoId) {
        console.log(`[git.clone] Initializing Unix group for repo ${shortId(repoId)}`);
        const result = await handleUnixSyncRepo(
          {
            ...payload,
            command: 'unix.sync-repo',
            params: {
              repoId,
              daemonUser: payload.params.daemonUser,
              initialize: true,
              ...(payload.params.userId ? { creatorUserId: payload.params.userId } : {}),
            },
          },
          options
        );
        if (!result.success) {
          throw new Error(result.error?.message ?? 'Unix repository permission sync failed');
        }
        unixGroup = (result.data as { groupName?: string } | undefined)?.groupName;
        if (!unixGroup) throw new Error('Unix repository permission sync returned no group');
        console.log(`[git.clone] Unix group initialized: ${unixGroup}`);
      }

      if (repoId) {
        await getExecutorReposService(client).patch(repoId, { clone_status: 'ready' });
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
        await getExecutorReposService(client).patch(payload.params.repoId, {
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
 * @param configuredHostIp - Host IP override from daemon-resolved config (config.daemon.host_ip_address)
 * @returns Rendered template fields
 */
async function renderEnvironmentTemplates(
  client: AgorClient,
  branchId: string,
  repoId: string,
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
  const { getGidFromGroupName, resolveBranchGroupName } = await import('@agor/core/unix');
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
  const unixGid = branch.unix_group
    ? getGidFromGroupName(resolveBranchGroupName(branchId as BranchID, branch.unix_group))
    : undefined;

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
  let resolvedRepoPath: string | undefined;
  let resolvedBranchPath: string | undefined;
  let resolvedBranchName: string | undefined;

  // Dry run mode
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'git.branch.add',
        branchId,
        repoId: payload.params.repoId,
        restoreMode: payload.params.restoreMode,
        useReference: payload.params.useReference,
      },
    };
  }

  let client: AgorClient | null = null;
  let lifecycleOwnershipVerified = false;

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.branch.add] Connected to daemon');

    // Resolve filesystem-bearing repository metadata through the scoped
    // service token in this same executor. This makes authorization, trusted
    // path resolution, credential scrub, and materialization one operation.
    const branchRecord = await client.service('branches').get(branchId);
    if (branchRecord.repo_id !== payload.params.repoId) {
      throw new Error(`Branch ${branchId} does not belong to repository ${payload.params.repoId}`);
    }
    if (
      branchRecord.archived ||
      branchRecord.filesystem_status !== 'creating' ||
      branchRecord.filesystem_operation_id !== payload.params.filesystemOperationId
    ) {
      throw new BranchFilesystemOperationSupersededError('creation');
    }
    lifecycleOwnershipVerified = true;
    const repo = await client.service('repos').get(payload.params.repoId);

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client, payload.params.userId);

    // Get parameters
    const repoId = payload.params.repoId;
    const branchPath = branchRecord.path;
    const repoPath = repo.local_path;
    const branchName = branchRecord.name;
    resolvedRepoPath = repoPath;
    resolvedBranchPath = branchPath;
    resolvedBranchName = branchName;
    const branch = branchRecord.ref || branchName;
    const shouldCreateBranch = branchRecord.new_branch ?? false;
    const sourceBranch = branchRecord.base_ref || repo.default_branch || 'main';
    const refType = branchRecord.ref_type;
    const restoreMode = payload.params.restoreMode ?? false;
    const storageMode = branchRecord.storage_mode ?? 'worktree';
    const cloneDepth = branchRecord.clone_depth;
    const remoteUrl = repo.remote_url ? stripGitUrlCredentials(repo.remote_url) : undefined;
    const referencePath = payload.params.useReference ? repo.local_path : undefined;

    if (!isValidManagedRepoSlug(repo.slug) || !isValidManagedBranchName(branchName)) {
      throw new Error('SAFETY CHECK FAILED: Branch filesystem identity is incomplete');
    }
    const canonicalBranchPath = resolve(payload.params.branchesRoot, repo.slug, branchName);
    if (resolve(branchPath) !== canonicalBranchPath) {
      throw new Error('SAFETY CHECK FAILED: Branch path does not match its canonical identity');
    }

    if (!repoPath && storageMode === 'worktree') {
      throw new Error(`Repository ${repoId} has no local_path for worktree materialization`);
    }

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
          `Cannot materialize clone-mode branch: tenant-scoped repository ${repoId} has no remote_url.`
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

    // Apply Unix isolation in this same tenant-mounted lifecycle executor.
    // This is awaited and fail-closed so the branch cannot become ready first.
    let unixGroup: string | undefined;
    if (payload.params.initUnixGroup && branchId) {
      console.log(`[git.branch.add] Initializing Unix group for branch ${shortId(branchId)}`);
      const result = await handleUnixSyncBranch(
        {
          ...payload,
          command: 'unix.sync-branch',
          params: {
            branchId,
            daemonUser: payload.params.daemonUser,
          },
        },
        options
      );
      if (!result.success) {
        throw new Error(result.error?.message ?? 'Unix branch permission sync failed');
      }
      unixGroup = (result.data as { groupName?: string } | undefined)?.groupName;
      if (!unixGroup) throw new Error('Unix branch permission sync returned no group');
      console.log(`[git.branch.add] Unix group initialized: ${unixGroup}`);
    } else if (payload.params.fixBasicPermissions && storageMode === 'worktree') {
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
      await getExecutorBranchesService(client).patch(branchId, {
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
    const fallbackPath = resolvedBranchPath;
    let fallbackCreated = false;
    let fallbackPermissionsApplied = false;
    if (fallbackPath && lifecycleOwnershipVerified) {
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

      // Step 2: synchronously run idempotent repair in this lifecycle
      // executor, even when a prior attempt already created the directory.
      if (existsSync(fallbackPath) && payload.params.initUnixGroup && branchId && client) {
        try {
          const result = await handleUnixSyncBranch(
            {
              ...payload,
              command: 'unix.sync-branch',
              params: {
                branchId,
                daemonUser: payload.params.daemonUser,
              },
            },
            options
          );
          if (!result.success) {
            throw new Error(result.error?.message ?? 'Unix branch permission repair failed');
          }
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
        userMessage = `A branch named '${resolvedBranchName || 'unknown'}' already exists and is in use by another branch. Please choose a different name.`;
      } else {
        userMessage = `Directory '${resolvedBranchPath || resolvedBranchName || 'unknown'}' already exists. An archived or partially-cleaned branch may still occupy this path.`;
      }
    }

    // Try to mark branch as failed with error details (if we have a branchId and client)
    if (branchId && client && lifecycleOwnershipVerified) {
      try {
        await getExecutorBranchesService(client).patch(branchId, {
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
          repoPath: resolvedRepoPath,
          branchName: resolvedBranchName,
          branchPath: resolvedBranchPath,
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

class BranchFilesystemOperationSupersededError extends Error {
  constructor(operation: 'creation' | 'deletion') {
    super(`Branch filesystem ${operation} no longer owns the current lifecycle generation`);
    this.name = 'BranchFilesystemOperationSupersededError';
  }
}

/**
 * Handle git.branch.remove command
 *
 * Removes a branch from the filesystem and optionally deletes its database
 * record. These are deliberately ordered operations, not an atomic
 * transaction: metadata is retained when filesystem removal cannot be proved.
 */
export function sanitizeBranchDeletionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes('safety check failed') ||
    normalized.includes('no longer matches the persisted branch') ||
    normalized.includes('no longer owns the current lifecycle generation')
  ) {
    return 'Filesystem deletion was refused by a safety check. Review daemon diagnostics before retrying.';
  }
  if (
    normalized.includes('sudo') ||
    normalized.includes('permission denied') ||
    normalized.includes('eacces')
  ) {
    return 'Privileged filesystem deletion is unavailable or was denied. Check sudoers and retry.';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'Filesystem deletion timed out and may be incomplete. The branch was retained for retry.';
  }
  if (normalized.includes('could not be verified')) {
    return 'Filesystem deletion could not be verified. The branch was retained for retry.';
  }
  return 'Filesystem deletion failed. Review daemon diagnostics and retry.';
}

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
    const branchesRoot = payload.params.branchesRoot;
    const persistedBranch = await client.service('branches').get(branchId);
    if (
      persistedBranch.filesystem_status !== 'deleting' ||
      persistedBranch.filesystem_operation_id !== payload.params.filesystemOperationId
    ) {
      throw new BranchFilesystemOperationSupersededError('deletion');
    }
    if (!persistedBranch.path || persistedBranch.path !== branchPath) {
      throw new Error('Deletion request no longer matches the persisted branch path');
    }
    const storageMode = persistedBranch.storage_mode ?? payload.params.storageMode ?? 'worktree';
    if (payload.params.storageMode && payload.params.storageMode !== storageMode) {
      throw new Error('Deletion request no longer matches the persisted branch storage mode');
    }
    if (!persistedBranch.repo_id) {
      throw new Error('Safety check failed: Branch repository metadata is missing');
    }
    if (!isValidManagedBranchName(persistedBranch.name)) {
      throw new Error('Safety check failed: Branch name is not a single managed path segment');
    }
    const persistedRepo = await client.service('repos').get(persistedBranch.repo_id);
    const canonicalBranchPath = await canonicalFilesystemIdentity(branchPath);
    const tenantBranches = await fetchAllBranchesForRepo(client);
    for (const candidate of tenantBranches) {
      if (!candidate.path || candidate.branch_id === branchId) continue;
      const candidatePath = await canonicalFilesystemIdentity(candidate.path);
      if (filesystemPathsOverlap(canonicalBranchPath, candidatePath)) {
        throw new Error('SAFETY CHECK FAILED: Branch root overlaps another metadata owner');
      }
    }
    const tenantRepos = await fetchAllRepos(client);
    for (const candidateRepo of tenantRepos) {
      if (
        candidateRepo.repo_id === persistedBranch.repo_id ||
        !isValidManagedRepoSlug(candidateRepo.slug)
      ) {
        continue;
      }
      const candidateNamespace = await canonicalFilesystemIdentity(
        resolve(branchesRoot, candidateRepo.slug)
      );
      if (filesystemPathsOverlap(canonicalBranchPath, candidateNamespace)) {
        throw new Error(
          'SAFETY CHECK FAILED: Legacy branch root overlaps another repository namespace'
        );
      }
    }
    const expectedRelativePath = join(persistedRepo.slug, persistedBranch.name);
    const deleteDirectory = () =>
      deleteBranchDirectory(branchPath, branchesRoot, {
        expectedRelativePath,
        privileged: payload.params.privilegedFilesystemDelete,
      });

    console.log(
      `[git.branch.remove] Removing branch at ${branchPath} (storageMode=${storageMode})...`
    );

    // Find the repo path from the branch's .git file
    const { lstat, readFile, realpath, stat } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { dirname, isAbsolute, resolve: resolvePath } = await import('node:path');

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
        await deleteDirectory();
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
        await deleteDirectory();
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
        const rawGitdirPath = match[1].trim();
        const gitdirPath = isAbsolute(rawGitdirPath)
          ? resolvePath(rawGitdirPath)
          : resolvePath(branchPath, rawGitdirPath);
        const gitBranchesDir = dirname(gitdirPath); // <repo>/.git/worktrees
        const dotGitDir = dirname(gitBranchesDir); // <repo>/.git
        const repoPath = dirname(dotGitDir); // <repo>

        // The .git pointer lives in user-writable branch content. Never trust
        // it to select a repository: bind it back to the tenant/RLS-scoped DB
        // record before asking git to mutate shared worktree metadata.
        const [resolvedRepoPath, resolvedPersistedRepoPath] = await Promise.all([
          realpath(repoPath),
          realpath(persistedRepo.local_path),
        ]);
        if (resolvedRepoPath !== resolvedPersistedRepoPath) {
          throw new Error('Safety check failed: Worktree gitdir does not match its repository');
        }

        console.log(`[git.branch.remove] Validated repository for worktree removal`);

        // Deregister the git worktree (removes the `.git/worktrees/<name>/`
        // entry from the base repo). Wraps `git worktree remove --force`.
        try {
          await removeGitWorktree(resolvedRepoPath, branchPath);
          console.log(`[git.branch.remove] Git worktree deregistered`);
        } catch (worktreeError) {
          const worktreeMessage =
            worktreeError instanceof Error ? worktreeError.message : String(worktreeError);
          // Git can surface the same partial ACL failure in two ways: the
          // underlying unlink/rmdir EACCES, or a final ENOTEMPTY/"Directory
          // not empty" after it removed everything it could. Both leave the
          // already-validated exact branch root behind and are safe to hand to
          // the scoped privileged remover before retrying deregistration.
          const partialFilesystemRemoval =
            /\b(?:EACCES|EPERM|ENOTEMPTY)\b|permission denied|operation not permitted|directory not empty/i.test(
              worktreeMessage
            );
          if (!payload.params.privilegedFilesystemDelete || !partialFilesystemRemoval) {
            throw worktreeError;
          }

          // `git worktree remove` deletes the tree as the executor user and can
          // hit the same ACL mask failure as a clone. Remove only the validated
          // exact root through sudo, then ask git to discard the now-missing
          // worktree's administrative entry. No broad prune is used here.
          console.warn(
            '[git.branch.remove] Worktree removal hit a permission boundary; retrying exact-root deletion through sudo'
          );
          await deleteDirectory();
          const worktreeStillRegistered = (await listGitWorktrees(resolvedRepoPath)).some(
            (worktree) => resolvePath(worktree.path) === resolvePath(branchPath)
          );
          if (worktreeStillRegistered) {
            await removeGitWorktree(resolvedRepoPath, branchPath);
            console.log(`[git.branch.remove] Git worktree deregistered after privileged removal`);
          } else {
            console.log(
              '[git.branch.remove] Git worktree was already deregistered by the partial removal'
            );
          }
        }

        // git worktree remove --force may leave residual files on disk.
        // Fully delete the directory to reclaim all disk space.
        if (existsSync(branchPath)) {
          console.log(`[git.branch.remove] Directory still exists, removing residual files...`);
          await deleteDirectory();
          console.log(`[git.branch.remove] Directory fully removed`);
        }

        filesystemRemoved = true;
        console.log(`[git.branch.remove] Branch removed from filesystem`);

        // Delete the associated branch if requested
        if (payload.params.deleteBranch && payload.params.branch) {
          const branchToDelete = payload.params.branch;
          try {
            console.log(`[git.branch.remove] Deleting branch '${branchToDelete}'...`);
            const deleted = await deleteBranch(resolvedRepoPath, branchToDelete);
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
      await deleteDirectory();
      filesystemRemoved = true;
      console.log('[git.branch.remove] Orphaned directory removed');
    } else {
      console.log('[git.branch.remove] Branch does not exist on filesystem, skipping git removal');
    }

    // Every teardown path, including `git worktree remove`, must end with an
    // authoritative absence check. A successful subprocess exit is not proof
    // that ignored files, mount contents, or concurrent residue are gone.
    try {
      await lstat(branchPath);
      throw new Error('Branch directory deletion could not be verified');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await getExecutorBranchesService(client).patch(branchId, {
      filesystem_status: 'deleted',
    });

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
    const userMessage = sanitizeBranchDeletionError(error);
    console.error('[git.branch.remove] Failed:', errorMessage);

    if (client && !(error instanceof BranchFilesystemOperationSupersededError)) {
      try {
        await getExecutorBranchesService(client).patch(payload.params.branchId, {
          filesystem_status: 'delete_failed',
          error_message: userMessage,
        });
      } catch {
        console.error('[git.branch.remove] Failed to persist delete_failed status');
      }
    }

    return {
      success: false,
      error: {
        code: 'GIT_BRANCH_REMOVE_FAILED',
        message: userMessage,
        details: {
          branchId: payload.params.branchId,
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
