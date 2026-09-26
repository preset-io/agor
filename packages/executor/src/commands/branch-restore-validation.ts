import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Branch, getTeammateConfig, type Repo } from '@agor/core/types';
import { createGit, stripGitUrlCredentials } from '../git/index.js';

/** Executor-only, non-destructive adoption. Existence is never proof of Git usability. */
export async function validateExistingRestore(branch: Branch, repo: Repo): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(branch.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory())
    throw new Error('Restore requires an existing directory, not a file or symlink.');
  await access(branch.path, constants.R_OK | constants.W_OK | constants.X_OK);
  if (getTeammateConfig(branch)?.localHome) {
    // Local homes are personal storage, not reconstructible Git checkouts.
    // A backed-up home need not contain .git; never initialize or clone into it.
    if ((await readdir(branch.path)).length === 0)
      throw new Error('Local teammate home is empty. Restore personal files from your own backup.');
    return true;
  }
  try {
    const metadata = await lstat(join(branch.path, '.git'));
    if (branch.storage_mode === 'clone' && (!metadata.isDirectory() || metadata.isSymbolicLink()))
      throw new Error('Clone requires a local .git directory');
    const { git } = createGit(branch.path);
    const root = await realpath(branch.path);
    if ((await realpath((await git.revparse(['--show-toplevel'])).trim())) !== root)
      throw new Error('Git root does not match the workspace');
    await git.revparse(['HEAD^{commit}']);
    const expected = branch.ref || branch.name;
    if ((branch.ref_type ?? 'branch') === 'branch') {
      if (
        (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim() !==
        `refs/heads/${expected.replace(/^refs\/heads\//, '')}`
      )
        throw new Error('Git checkout is on a different branch');
    } else if (
      (await git.revparse(['HEAD'])).trim() !==
      (await git.revparse([`${expected}^{commit}`])).trim()
    ) {
      throw new Error('Git checkout does not match the requested ref');
    }
    const gitDir = await realpath((await git.revparse(['--absolute-git-dir'])).trim());
    const common = await realpath(resolve(root, (await git.revparse(['--git-common-dir'])).trim()));
    if ((branch.storage_mode ?? 'worktree') === 'worktree') {
      if (!repo.local_path) throw new Error('Authoritative base repository is unavailable');
      const { git: base } = createGit(repo.local_path);
      const baseCommon = await realpath(
        resolve(repo.local_path, (await base.revparse(['--git-common-dir'])).trim())
      );
      if (common !== baseCommon) throw new Error('Git linkage points to a different repository');
      // A valid forward .git pointer alone is insufficient: require the base's
      // registered worktree and its back-link to agree with this exact path.
      const registered = (await base.raw(['worktree', 'list', '--porcelain', '-z'])).split('\0');
      if (
        !registered.includes(`worktree ${root}`) ||
        (await realpath((await readFile(join(gitDir, 'gitdir'), 'utf8')).trim())) !==
          (await realpath(join(root, '.git')))
      )
        throw new Error('Git worktree registration is missing or inconsistent');
    } else {
      if (gitDir !== join(root, '.git') || common !== gitDir)
        throw new Error('Clone Git metadata is not local to the workspace');
      const origin = stripGitUrlCredentials(
        (await git.remote(['get-url', 'origin']))?.trim() ?? ''
      );
      if (!repo.remote_url || origin !== stripGitUrlCredentials(repo.remote_url))
        throw new Error('Clone origin does not match the authoritative repository');
    }
    // Legacy worktrees have no marker. Their bidirectional repository linkage
    // (or a clone's exact origin) above is required instead; a wrong marker fails.
    try {
      const marker = (await readFile(join(gitDir, 'agor-branch-id'), 'utf8')).trim();
      if (marker !== branch.branch_id) throw new Error('Workspace belongs to another branch');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return true;
  } catch {
    throw new Error(
      'Existing workspace has invalid Git linkage, ownership, or ref. An operator must verify storage and backups before target-scoped repair in the executor storage context; recovery will not overwrite personal files. Do not run global worktree repair or prune.'
    );
  }
}
