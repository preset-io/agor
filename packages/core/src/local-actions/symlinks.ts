import {
  AGOR_HOME_BASE,
  createAdminExecutor,
  getBranchSymlinkPath,
  getUserBranchesDir,
  isValidUnixUsername,
  SymlinkCommands,
} from '../unix/index.js';
import { getReporter, type LocalActionOptions } from './types.js';

function assertSafeSymlinkBranchName(branchName: string): void {
  if (
    branchName.length === 0 ||
    branchName === '.' ||
    branchName === '..' ||
    branchName.includes('/') ||
    branchName.includes('\\') ||
    branchName.includes('\0')
  ) {
    throw new Error(`Invalid branch name for symlink path: ${branchName}`);
  }
}

export interface CreateBranchSymlinkParams extends LocalActionOptions {
  username: string;
  branchName: string;
  branchPath: string;
  homeBase?: string;
}

export async function createBranchSymlinkAction(params: CreateBranchSymlinkParams): Promise<void> {
  const reporter = getReporter(params);
  const homeBase = params.homeBase ?? AGOR_HOME_BASE;
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  if (!isValidUnixUsername(params.username)) {
    throw new Error(`Invalid Unix username format: ${params.username}`);
  }
  if (!params.branchPath.startsWith('/')) {
    throw new Error(`Branch path must be absolute: ${params.branchPath}`);
  }
  assertSafeSymlinkBranchName(params.branchName);

  const linkPath = getBranchSymlinkPath(params.username, params.branchName, homeBase);
  try {
    const result = await executor.exec(SymlinkCommands.readSymlink(linkPath));
    const existingTarget = result.stdout.trim();
    if (existingTarget === params.branchPath) {
      reporter.log(`✅ Symlink already exists: ${linkPath} -> ${params.branchPath}`);
      return;
    }
    reporter.log(`ℹ️  Updating symlink (was: ${existingTarget})`);
  } catch {
    // Symlink doesn't exist, will create.
  }

  await executor.execAll(
    SymlinkCommands.createSymlinkWithOwnership(params.branchPath, linkPath, params.username)
  );
  reporter.log(`✅ Created symlink: ${linkPath} -> ${params.branchPath}`);
}

export interface RemoveBranchSymlinkParams extends LocalActionOptions {
  username: string;
  branchName: string;
  homeBase?: string;
}

export async function removeBranchSymlinkAction(params: RemoveBranchSymlinkParams): Promise<void> {
  const reporter = getReporter(params);
  const homeBase = params.homeBase ?? AGOR_HOME_BASE;
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  if (!isValidUnixUsername(params.username)) {
    throw new Error(`Invalid Unix username format: ${params.username}`);
  }
  assertSafeSymlinkBranchName(params.branchName);

  const linkPath = getBranchSymlinkPath(params.username, params.branchName, homeBase);
  const symlinkExists = await executor.check(SymlinkCommands.symlinkExists(linkPath));
  if (!symlinkExists) {
    reporter.log(`✅ Symlink does not exist: ${linkPath} (nothing to do)`);
    return;
  }

  await executor.exec(SymlinkCommands.removeSymlink(linkPath));
  reporter.log(`✅ Removed symlink: ${linkPath}`);
}

export interface CleanupBrokenSymlinksParams extends LocalActionOptions {
  username: string;
  homeBase?: string;
}

export async function cleanupBrokenSymlinksAction(
  params: CleanupBrokenSymlinksParams
): Promise<void> {
  const reporter = getReporter(params);
  const homeBase = params.homeBase ?? AGOR_HOME_BASE;
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  if (!isValidUnixUsername(params.username)) {
    throw new Error(`Invalid Unix username format: ${params.username}`);
  }

  const branchesDir = getUserBranchesDir(params.username, homeBase);
  const dirExists = await executor.check(SymlinkCommands.pathExists(branchesDir));
  if (!dirExists) {
    reporter.log(`✅ Branches directory does not exist: ${branchesDir} (nothing to do)`);
    return;
  }

  await executor.exec(SymlinkCommands.removeBrokenSymlinks(branchesDir));
  reporter.log(`✅ Cleaned up broken symlinks in: ${branchesDir}`);
}
