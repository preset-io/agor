/**
 * Git Command Handlers for Executor
 *
 * These handlers execute git operations directly in the executor process.
 * This enables consistent substrate, credential, and environment handling for
 * filesystem operations on RBAC-protected branches.
 *
 * The executor handles the complete transaction:
 * 1. Filesystem operations (git clone, git worktree add/remove)
 * 2. Database record creation via Feathers services
 *
 * Feathers hooks handle WebSocket broadcasts automatically when records are created/updated.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getReposDir } from '@agor/core/config';
import { parseAgorYml, writeAgorYml } from '@agor/core/config/node';
import { shortId } from '@agor/core/db';
import { TEAMMATE_FRAMEWORK_REPO_URL } from '@agor/core/types';
import { diagnoseGit } from '@agor/git';
import type { UserGitEnvironment } from '@agor/git/pure';
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
  isRemoteRefVisibleForClone,
  isValidGitRepo,
  redactGitUrlCredentials,
  removeGitWorktree,
  resolveGitRef,
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
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

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
    const repoPath = resolve(inputPath);
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
 * Fetch the requesting executor token owner's bounded Git environment.
 *
 * The daemon derives the principal from the exact git.clone/git.branch.add
 * command token. No caller-supplied user ID participates in credential
 * selection, and ordinary user/admin transports cannot call the capability.
 *
 * RPC failures are intentionally NOT swallowed: this is the channel through
 * which per-user credentials reach git operations. If we returned `{}`
 * on failure, git would silently fall back to the daemon user's ambient
 * credentials (e.g. `gh auth login`), which is exactly the cross-user leak
 * this whole flow is designed to prevent.
 */
async function fetchUserGitEnvironment(client: AgorClient): Promise<UserGitEnvironment> {
  return client.service('executor-git-environment').create({});
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
  const { repoId, repoPath, remoteUrl, repoSlug } = payload.params;

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

  try {
    const result = await ensureGitRemoteUrl(repoPath, 'origin', remoteUrl);
    if (result.changed) {
      const { redactUrlUserinfo } = await import('@agor/core/config');
      console.warn(
        `[SECURITY] Realigned remote.origin.url for repo ${repoId} (slug=${repoSlug}); ` +
          `canonical URL now: ${redactUrlUserinfo(remoteUrl)}`
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

  const deletedPaths: string[] = [];
  const { repoPath, branchPaths } = payload.params;

  try {
    for (const branchPath of branchPaths) {
      await deleteBranchDirectory(branchPath, payload.params.branchesRoot);
      deletedPaths.push(branchPath);
      console.log(`🗑️  [git.repo.delete] Deleted branch directory: ${branchPath}`);
    }

    await deleteRepoDirectory(repoPath, payload.params.reposRoot);
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

    // This check must run inside the executor, after launcher setup, because that is the process whose PATH and identity own the
    // actual clone. A CLI/daemon preflight can pass while this runtime cannot
    // resolve Git (for example, with a filtered PATH or remote executor).
    const git = await diagnoseGit();
    if (git.status !== 'ready') {
      throw new Error(git.detail ?? 'Git executable is unavailable.');
    }
    console.log(`[git.clone] Git ${git.version} is executable (${git.binary})`);

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client);
    if (Object.keys(env).length > 0) {
      console.log('[git.clone] Resolved credentials:', Object.keys(env));
    }

    // Determine output path. Prefer the daemon-supplied path; otherwise use
    // the Agor slug when present so same-basename remotes do not collide.
    const outputPath = cloneOutputPath;
    // Managed clone requests carry the canonical tenant-scoped destination
    // selected by the daemon. Do not consult the executor's ambient config in
    // that path: an auth-resolved tenant belongs to the verified service
    // capability, not to process-global state. Direct/ad-hoc invocations that
    // omit outputPath retain the configured fallback and therefore still fail
    // closed when filesystem isolation requires tenant context.
    const reposDir = outputPath ? dirname(outputPath) : getReposDir();

    // The daemon selects this canonical, tenant-scoped destination. Trust only
    // that exact path for this one-purpose executor process so an existing
    // managed clone can be inspected/reused by the selected substrate.
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

    // Compute slug for the repo
    const slug = payload.params.slug || computeRepoSlug(safeCloneUrl);
    const repoName = extractRepoName(slug);

    // Create DB record if requested (default: true)
    let repoId: string | undefined;

    if (createDbRecord) {
      // Parse .agor.yml for environment config (if present). Returns v2
      // RepoEnvironment; legacy v1 files are wrapped as variants.default.
      const agorYmlPath = join(cloneResult.path, '.agor.yml');
      let environment: import('@agor/core/types').RepoEnvironment | null = null;

      if (payload.params.importEnvironmentConfig) {
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
        await client.service('repos').patch(repoId, {
          name: repoName,
          local_path: cloneResult.path,
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
          clone_status: 'cloning',
          ...(environment ? { environment } : {}),
        });
        repoId = repoRecord.repo_id;
        console.log(`[git.clone] Repo record created: ${repoId}`);
      }

      if (repoId) {
        await client.service('repos').patch(repoId, { clone_status: 'ready' });
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

  try {
    // Connect to daemon
    const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
    client = await createExecutorClient(daemonUrl, payload.sessionToken);
    console.log('[git.branch.add] Connected to daemon');

    // Resolve filesystem-bearing repository metadata through the initiating
    // user's delegated Feathers authority in this same executor.
    const repo = await client.service('repos').get(payload.params.repoId);
    const branchRecord = await client.service('branches').get(branchId);
    if (branchRecord.repo_id !== payload.params.repoId) {
      throw new Error(`Branch ${branchId} does not belong to repository ${payload.params.repoId}`);
    }

    // Fetch per-user git credentials via Feathers RPC
    const env = await fetchUserGitEnvironment(client);

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
    const baseRemoteUrl = branchRecord.base_remote_url
      ? stripGitUrlCredentials(branchRecord.base_remote_url)
      : undefined;
    if (baseRemoteUrl && baseRemoteUrl !== TEAMMATE_FRAMEWORK_REPO_URL) {
      throw new Error(
        'Refusing untrusted base_remote_url: only the canonical Agor teammate template repository is allowed.'
      );
    }
    const referencePath = payload.params.useReference ? repo.local_path : undefined;

    if (!repoPath && storageMode === 'worktree') {
      throw new Error(`Repository ${repoId} has no local_path for worktree materialization`);
    }

    console.log(`[git.branch.add] Creating branch at ${branchPath}...`);
    console.log(
      `[git.branch.add] Repo: ${repoPath}, Branch: ${branch}, CreateBranch: ${shouldCreateBranch}, RestoreMode: ${restoreMode}, RefType: ${refType || 'branch'}, StorageMode: ${storageMode}`
    );

    // Resolve the user-controlled starting point once, before storage-mode
    // dispatch. Worktree and clone materializers consume this concrete result
    // and must not independently guess or qualify the ref.
    const requestedStartingRef = shouldCreateBranch ? sourceBranch : branch;
    const resolveStartingRef = () =>
      resolveGitRef(repoPath, requestedStartingRef, {
        refType: refType || 'branch',
        ...(baseRemoteUrl
          ? { remote: { url: baseRemoteUrl }, remoteOnly: true }
          : remoteUrl
            ? { remote: { url: remoteUrl, name: 'origin' } }
            : {}),
        env,
      });
    const resolvedStartingRef = restoreMode ? undefined : await resolveStartingRef();

    if (resolvedStartingRef) {
      await client.service('branches').patch(branchId, {
        base_ref: resolvedStartingRef.ref,
        base_sha: resolvedStartingRef.sha,
      });
      console.log(
        `[git.branch.add] Resolved '${requestedStartingRef}' to ${resolvedStartingRef.ref} @ ${resolvedStartingRef.sha}`
      );
    }

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
      let cloneRef = resolvedStartingRef?.name ?? branch;
      let cloneRemoteUrl = remoteUrl;
      let newBranchName: string | undefined;
      const detached = resolvedStartingRef?.kind === 'commit';

      if (shouldCreateBranch) {
        const restoreFromDestination = restoreMode
          ? await isRemoteRefVisibleForClone({
              remoteUrl,
              ref: branch,
              refType: 'branch',
              env,
            })
          : false;

        if (!restoreFromDestination) {
          cloneRef = resolvedStartingRef?.name ?? sourceBranch ?? branch;
          cloneRemoteUrl =
            resolvedStartingRef?.remoteUrl ??
            (resolvedStartingRef?.kind === 'local_branch' ||
            resolvedStartingRef?.kind === 'commit' ||
            (resolvedStartingRef?.kind === 'tag' && !resolvedStartingRef.remoteUrl)
              ? repoPath
              : baseRemoteUrl || remoteUrl);
          newBranchName = branch !== cloneRef ? branch : undefined;
        }
      } else if (resolvedStartingRef) {
        cloneRemoteUrl =
          resolvedStartingRef.remoteUrl ??
          (resolvedStartingRef.kind === 'local_branch' ||
          resolvedStartingRef.kind === 'commit' ||
          resolvedStartingRef.kind === 'tag'
            ? repoPath
            : remoteUrl);
      }
      if (!cloneRemoteUrl) {
        throw new Error(`Cannot materialize resolved ref '${requestedStartingRef}': no source URL`);
      }
      console.log(
        `[git.branch.add] Using createBranchAsClone (sourceRemote=${redactGitUrlCredentials(cloneRemoteUrl)}, ` +
          `origin=${redactGitUrlCredentials(remoteUrl)}, ` +
          `ref=${cloneRef}${newBranchName ? `, newBranch=${newBranchName}` : ''}, ` +
          `depth=${cloneDepth ?? 'full'}, referenceHint=${referencePath ?? 'none'})`
      );
      await createBranchAsClone({
        remoteUrl: cloneRemoteUrl,
        ...(remoteUrl && cloneRemoteUrl !== remoteUrl ? { originRemoteUrl: remoteUrl } : {}),
        targetPath: branchPath,
        ref: cloneRef,
        ...(newBranchName ? { newBranchName } : {}),
        ...(detached ? { detached: true } : {}),
        ...(resolvedStartingRef ? { expectedSha: resolvedStartingRef.sha } : {}),
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
      const result = await restoreBranchFilesystem(
        repoPath,
        branchPath,
        branch,
        sourceBranch,
        env,
        baseRemoteUrl,
        refType || 'branch',
        remoteUrl
      );
      if (!result.success) {
        throw new Error(`restoreBranchFilesystem failed: ${result.error}`);
      }
      console.log(`[git.branch.add] Restored branch via ${result.strategy} strategy`);
    } else {
      await createBranch(
        repoPath,
        branchPath,
        shouldCreateBranch ? branch : (resolvedStartingRef?.ref ?? branch),
        shouldCreateBranch,
        true, // pullLatest
        shouldCreateBranch ? resolvedStartingRef?.ref : undefined,
        env,
        refType,
        baseRemoteUrl,
        remoteUrl,
        resolvedStartingRef?.sha
      );
    }

    console.log(`[git.branch.add] Branch created at ${branchPath}`);

    // Persist only filesystem outcome directly. Executable environment
    // rendering belongs to the daemon's existing authorization/validation
    // boundary and is derived there from trusted repo configuration.
    if (branchId) {
      console.log(`[git.branch.add] Marking branch ${shortId(branchId)} as ready`);
      await client.service('branches').patch(branchId, { filesystem_status: 'ready' });
      console.log(`[git.branch.add] Branch marked as ready`);

      if (repo.environment) {
        try {
          const renderer = client.service(`branches/${branchId}/render-environment`) as unknown as {
            create(data: Record<string, never>): Promise<unknown>;
          };
          await renderer.create({});
          console.log(`[git.branch.add] Environment templates rendered by daemon`);
        } catch (error) {
          console.error(
            `[git.branch.add] Failed to render templates:`,
            error instanceof Error ? error.message : String(error)
          );
          // Filesystem materialization succeeded; keep the branch usable even
          // if environment rendering is independently unavailable.
        }
      }
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
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[git.branch.add] Failed:', errorMessage);

    // Fallback: preserve the historical empty-directory recovery behavior
    // when git worktree add fails. No host permission repair is attempted.
    const fallbackPath = resolvedBranchPath;
    let fallbackCreated = false;
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
          repoPath: resolvedRepoPath,
          branchName: resolvedBranchName,
          branchPath: resolvedBranchPath,
          fallbackDirectoryCreated: fallbackCreated,
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
        storageMode: payload.params.storageMode,
      },
    };
  }

  try {
    const branchId = payload.params.branchId;
    const branchPath = payload.params.branchPath;
    const branchesRoot = payload.params.branchesRoot;
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
        await deleteBranchDirectory(branchPath, branchesRoot);
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
        await deleteBranchDirectory(branchPath, branchesRoot);
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
          await deleteBranchDirectory(branchPath, branchesRoot);
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
      await deleteBranchDirectory(branchPath, branchesRoot);
      filesystemRemoved = true;
      console.log('[git.branch.remove] Orphaned directory removed');
    } else {
      console.log('[git.branch.remove] Branch does not exist on filesystem, skipping git removal');
    }

    return {
      success: true,
      data: {
        branchId,
        branchPath,
        filesystemRemoved,
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
