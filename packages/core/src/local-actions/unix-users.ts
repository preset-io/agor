import {
  AGOR_HOME_BASE,
  createAdminExecutor,
  isValidUnixUsername,
  UnixUserCommands,
} from '../unix/index.js';
import { getReporter, type LocalActionOptions } from './types.js';

export interface EnsureUnixUserParams extends LocalActionOptions {
  username: string;
  homeBase?: string;
}

export async function ensureUnixUserAction(params: EnsureUnixUserParams): Promise<void> {
  const reporter = getReporter(params);
  const homeBase = params.homeBase ?? AGOR_HOME_BASE;
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  if (!isValidUnixUsername(params.username)) {
    throw new Error(`Invalid Unix username format: ${params.username}`);
  }

  const userExists = await executor.check(UnixUserCommands.userExists(params.username));
  if (userExists) {
    reporter.log(`✅ Unix user ${params.username} already exists`);
    await executor.execAll(UnixUserCommands.setupBranchesDir(params.username, homeBase));
    reporter.log(`✅ Ensured ~/agor/worktrees directory for ${params.username}`);
    return;
  }

  reporter.log(`Creating Unix user: ${params.username}`);
  await executor.exec(UnixUserCommands.createUser(params.username, '/bin/bash', homeBase));
  reporter.log(`✅ Created Unix user: ${params.username}`);
  await executor.execAll(UnixUserCommands.setupBranchesDir(params.username, homeBase));
  reporter.log(`✅ Created ~/agor/worktrees directory for ${params.username}`);
}

export interface DeleteUnixUserParams extends LocalActionOptions {
  username: string;
  deleteHome?: boolean;
}

export async function deleteUnixUserAction(params: DeleteUnixUserParams): Promise<void> {
  const reporter = getReporter(params);
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  if (!isValidUnixUsername(params.username)) {
    throw new Error(`Invalid Unix username format: ${params.username}`);
  }

  const userExists = await executor.check(UnixUserCommands.userExists(params.username));
  if (!userExists) {
    reporter.log(`✅ Unix user ${params.username} does not exist (nothing to do)`);
    return;
  }

  if (params.deleteHome) {
    await executor.exec(UnixUserCommands.deleteUserWithHome(params.username));
    reporter.log(`✅ Deleted Unix user ${params.username} and home directory`);
  } else {
    await executor.exec(UnixUserCommands.deleteUser(params.username));
    reporter.log(`✅ Deleted Unix user ${params.username} (home directory preserved)`);
  }
}
