import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromFile } from '@agor/core/config';
import {
  and,
  BranchRepository,
  branches,
  createDatabase,
  eq,
  repos,
  select,
  sessions,
  shortId,
  update,
  users,
} from '@agor/core/db';
import type { BranchID } from '@agor/core/types';
import {
  createAdminExecutor,
  getBranchPermissionMode,
  isValidUnixUsername,
  listBranchGroups,
  listRepoGroups,
  type PlannedUnixGroupResource,
  planUnixGroupUuidMigration,
  REPO_GIT_PERMISSION_MODE,
  runUnixGroupUuidMigration,
  UnixGroupCommands,
  type UnixGroupCompareAndSetResult,
  type UnixGroupMigrationResource,
} from '@agor/core/unix';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';

interface RawBranch {
  branch_id: string;
  repo_id: string;
  name: string;
  unix_group: string | null;
  others_fs_access: 'none' | 'read' | 'write' | null;
  data: { path?: string } | null;
}

interface RawRepo {
  repo_id: string;
  slug: string;
  unix_group: string | null;
  data: { local_path?: string } | null;
}

interface RawSession {
  branch_id: string;
  unix_username: string | null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function invokingAgorHome(): string {
  const sudoUser = process.env.SUDO_USER;

  if (sudoUser) {
    try {
      const passwdEntry = execSync(`getent passwd ${shellQuote(sudoUser)}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return join(passwdEntry.split(':')[5], '.agor');
    } catch {
      return join('/home', sudoUser, '.agor');
    }
  }

  return join(homedir(), '.agor');
}

function defaultLocalDatabaseUrl(agorHome: string): string {
  return `file:${join(agorHome, 'agor.db')}`;
}

export default class FixGroupUuids extends Command {
  static override description =
    'Explicitly migrate legacy 8-character branch/repo Unix groups to collision-safe names';

  static override examples = [
    'sudo <%= config.bin %> <%= command.id %> --only-dups --dry-run',
    'sudo <%= config.bin %> <%= command.id %> --only-dups',
    'sudo <%= config.bin %> <%= command.id %> --dry-run  # Preview full legacy migration',
    'sudo <%= config.bin %> <%= command.id %>            # Migrate every legacy group',
  ];

  static override flags = {
    'only-dups': Flags.boolean({
      description: 'Migrate only real legacy collision cohorts (recommended)',
      default: false,
    }),
    'dry-run': Flags.boolean({
      char: 'n',
      description: 'Show the plan without changing groups, paths, or database rows',
      default: false,
    }),
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show privileged commands and detailed progress',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(FixGroupUuids);
    const dryRun = flags['dry-run'];

    if (!dryRun && typeof process.getuid === 'function' && process.getuid() !== 0) {
      this.error(
        'fix-group-uuids must run as root so it can verify every managed path. Re-run with sudo, or use --dry-run.'
      );
    }

    const agorHome = invokingAgorHome();
    const databaseUrl = process.env.DATABASE_URL || defaultLocalDatabaseUrl(agorHome);
    if (
      process.env.AGOR_DB_DIALECT === 'postgresql' ||
      /^(?:postgres(?:ql)?|pg):\/\//.test(databaseUrl) ||
      !databaseUrl.startsWith('file:')
    ) {
      this.error(
        'fix-group-uuids supports only the host-local single-tenant SQLite database. ' +
          'Unix groups are system-global, so a PostgreSQL/RLS or remote database view cannot prove that another tenant or host is not still using a legacy group.'
      );
    }

    const rawDatabasePath = databaseUrl.slice('file:'.length);
    const databasePath = rawDatabasePath.startsWith('~/')
      ? join(join(agorHome, '..'), rawDatabasePath.slice(2))
      : rawDatabasePath;
    if (!existsSync(databasePath)) {
      this.error(`Database not found: ${databasePath}`);
    }

    const db = createDatabase({ dialect: 'sqlite', url: `file:${databasePath}` });
    const configPath = join(agorHome, 'config.yaml');
    if (!existsSync(configPath)) {
      this.error(`Config not found: ${configPath}`);
    }
    const config = await loadConfigFromFile(configPath);
    const daemonUser = config.daemon?.unix_user;
    if (!daemonUser || !isValidUnixUsername(daemonUser)) {
      this.error(
        'daemon.unix_user must be configured to a valid Unix username before reconstructing group memberships.'
      );
    }

    const branchRows = (await select(db).from(branches).all()) as RawBranch[];
    const repoRows = (await select(db).from(repos).all()) as RawRepo[];
    const sessionRows = (await select(db, {
      branch_id: sessions.branch_id,
      unix_username: sessions.unix_username,
    })
      .from(sessions)
      .all()) as RawSession[];
    const userRows = (await select(db, {
      user_id: users.user_id,
      unix_username: users.unix_username,
    })
      .from(users)
      .all()) as Array<{ user_id: string; unix_username: string | null }>;

    const branchById = new Map(branchRows.map((branch) => [branch.branch_id, branch]));
    const repoById = new Map(repoRows.map((repo) => [repo.repo_id, repo]));
    const branchesByRepo = new Map<string, RawBranch[]>();
    for (const branch of branchRows) {
      const repoBranches = branchesByRepo.get(branch.repo_id) ?? [];
      repoBranches.push(branch);
      branchesByRepo.set(branch.repo_id, repoBranches);
    }
    const sessionsByBranch = new Map<string, Set<string>>();
    for (const session of sessionRows) {
      if (!session.unix_username) continue;
      if (!isValidUnixUsername(session.unix_username)) {
        this.error(
          `Session on branch ${shortId(session.branch_id)} has invalid unix_username ${session.unix_username}; refusing partial authorization reconstruction.`
        );
      }
      const usernames = sessionsByBranch.get(session.branch_id) ?? new Set<string>();
      usernames.add(session.unix_username);
      sessionsByBranch.set(session.branch_id, usernames);
    }
    const usernameByUserId = new Map<string, string>();
    for (const user of userRows) {
      if (!user.unix_username) continue;
      if (!isValidUnixUsername(user.unix_username)) {
        this.error(
          `User ${shortId(user.user_id)} has invalid unix_username ${user.unix_username}; refusing partial authorization reconstruction.`
        );
      }
      usernameByUserId.set(user.user_id, user.unix_username);
    }

    const resources: UnixGroupMigrationResource[] = [
      ...branchRows.map((branch) => ({
        kind: 'branch' as const,
        id: branch.branch_id,
        unixGroup: branch.unix_group,
        label: branch.name,
      })),
      ...repoRows.map((repo) => ({
        kind: 'repo' as const,
        id: repo.repo_id,
        unixGroup: repo.unix_group,
        label: repo.slug,
      })),
    ];
    const systemGroups = [...listBranchGroups(), ...listRepoGroups()];
    const plan = planUnixGroupUuidMigration(resources, {
      onlyDuplicates: flags['only-dups'],
      existingSystemGroups: systemGroups,
    });

    const pendingRows = plan.reduce((total, cohort) => total + cohort.resources.length, 0);
    this.log(chalk.cyan.bold('Unix group UUID migration'));
    this.log(`Mode: ${flags['only-dups'] ? 'duplicate cohorts only' : 'all legacy groups'}`);
    this.log(`Cohorts: ${plan.length}; pending rows: ${pendingRows}`);

    if (plan.length === 0) {
      this.log(chalk.green('\nNo matching legacy groups need migration.'));
      return;
    }

    for (const cohort of plan) {
      this.log(
        `  ${cohort.legacyGroup}: ${cohort.resources.length} pending, ` +
          `${cohort.collisionResourceIds.length} collision-cohort row(s)`
      );
      for (const resource of cohort.resources) {
        this.log(
          chalk.gray(
            `    ${resource.kind} ${resource.label} (${shortId(resource.id)}): ${resource.unixGroup} → ${resource.newGroup}`
          )
        );
      }
    }

    if (dryRun) {
      this.log(chalk.yellow('\nDry run: no Unix, filesystem, or database changes were made.'));
      return;
    }

    const executor = createAdminExecutor({ 'dry-run': false, verbose: flags.verbose });
    const branchRepository = new BranchRepository(db);

    const expectedBranchMembers = async (branch: RawBranch): Promise<Set<string>> => {
      const expected = new Set<string>([daemonUser]);
      const explicitUserIds = await branchRepository.findExplicitFsAccessUserIds(
        branch.branch_id as BranchID
      );
      for (const userId of explicitUserIds) {
        const username = usernameByUserId.get(userId);
        if (username) expected.add(username);
      }
      if ((branch.others_fs_access ?? 'read') === 'write') {
        for (const username of sessionsByBranch.get(branch.branch_id) ?? []) {
          expected.add(username);
        }
      }
      return expected;
    };

    const expectedRepoMembers = async (repo: RawRepo): Promise<Set<string>> => {
      const expected = new Set<string>([daemonUser]);
      for (const branch of branchesByRepo.get(repo.repo_id) ?? []) {
        const explicitUserIds = await branchRepository.findExplicitFsAccessUserIds(
          branch.branch_id as BranchID
        );
        for (const userId of explicitUserIds) {
          const username = usernameByUserId.get(userId);
          if (username) expected.add(username);
        }
        if ((branch.others_fs_access ?? 'read') !== 'none') {
          for (const username of sessionsByBranch.get(branch.branch_id) ?? []) {
            expected.add(username);
          }
        }
      }
      return expected;
    };

    const getMembers = async (groupName: string): Promise<Set<string>> => {
      const output = await executor.exec(UnixGroupCommands.listGroupMembers(groupName));
      return new Set(output.stdout.trim().split(',').filter(Boolean));
    };

    const inspectPath = async (path: string): Promise<{ group: string; acl: string[] }> => {
      const quotedPath = shellQuote(path);
      const [statResult, aclResult] = await Promise.all([
        executor.exec(`stat -c %G -- ${quotedPath}`),
        executor.exec(`getfacl -cp -- ${quotedPath}`),
      ]);
      return {
        group: statResult.stdout.trim(),
        acl: aclResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      };
    };

    const managedPathsFor = (resource: PlannedUnixGroupResource): string[] => {
      if (resource.kind === 'branch') {
        const path = branchById.get(resource.id)?.data?.path;
        return path && existsSync(path) ? [path] : [];
      }
      const path = repoById.get(resource.id)?.data?.local_path;
      if (!path || !existsSync(path)) return [];
      const gitPath = join(path, '.git');
      return existsSync(gitPath) ? [path, gitPath] : [path];
    };

    const result = await runUnixGroupUuidMigration(plan, {
      log: (message) => this.log(message),
      ensureGroup: async (groupName) => {
        if (!(await executor.check(UnixGroupCommands.groupExists(groupName)))) {
          await executor.exec(UnixGroupCommands.createGroup(groupName));
        }
      },
      expectedMembers: async (resource) => {
        if (resource.kind === 'branch') {
          const branch = branchById.get(resource.id);
          if (!branch) throw new Error('branch disappeared while migration was running');
          return expectedBranchMembers(branch);
        }
        const repo = repoById.get(resource.id);
        if (!repo) throw new Error('repo disappeared while migration was running');
        return expectedRepoMembers(repo);
      },
      reconcileMembers: async (groupName, expectedMembers) => {
        const current = await getMembers(groupName);
        for (const username of expectedMembers) {
          if (!current.has(username)) {
            await executor.exec(UnixGroupCommands.addUserToGroup(username, groupName));
          }
        }
        for (const username of current) {
          if (!expectedMembers.has(username)) {
            await executor.exec(UnixGroupCommands.removeUserFromGroup(username, groupName));
          }
        }
      },
      verifyMembers: async (groupName, expectedMembers) => {
        const actual = await getMembers(groupName);
        const missing = [...expectedMembers].filter((username) => !actual.has(username));
        const extra = [...actual].filter((username) => !expectedMembers.has(username));
        if (missing.length || extra.length) {
          throw new Error(
            `membership verification failed (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`
          );
        }
      },
      applyFilesystem: async (resource) => {
        if (resource.kind === 'branch') {
          const branch = branchById.get(resource.id);
          const path = branch?.data?.path;
          if (!branch || !path || !existsSync(path)) return;
          await executor.execAll([
            ...UnixGroupCommands.setDirectoryGroup(
              path,
              resource.newGroup,
              getBranchPermissionMode(branch.others_fs_access ?? 'read')
            ),
            ...UnixGroupCommands.removeDirectoryGroupAcl(path, resource.unixGroup),
          ]);
          return;
        }

        const repo = repoById.get(resource.id);
        const path = repo?.data?.local_path;
        if (!path || !existsSync(path)) return;
        const commands = [
          ...UnixGroupCommands.setDirectoryGroupShallow(
            path,
            resource.newGroup,
            REPO_GIT_PERMISSION_MODE
          ),
          ...UnixGroupCommands.removeDirectoryGroupAclShallow(path, resource.unixGroup),
        ];
        const gitPath = join(path, '.git');
        if (existsSync(gitPath)) {
          commands.push(
            ...UnixGroupCommands.setDirectoryGroup(
              gitPath,
              resource.newGroup,
              REPO_GIT_PERMISSION_MODE
            ),
            ...UnixGroupCommands.removeDirectoryGroupAcl(gitPath, resource.unixGroup)
          );
        }
        await executor.execAll(commands);
      },
      verifyFilesystem: async (resource) => {
        for (const path of managedPathsFor(resource)) {
          const state = await inspectPath(path);
          const hasNewAcl = state.acl.some((line) =>
            line.startsWith(`group:${resource.newGroup}:`)
          );
          const hasOldAcl = state.acl.some(
            (line) =>
              line.startsWith(`group:${resource.unixGroup}:`) ||
              line.startsWith(`default:group:${resource.unixGroup}:`)
          );
          if (state.group !== resource.newGroup || !hasNewAcl || hasOldAcl) {
            throw new Error(
              `filesystem verification failed for ${path} (group=${state.group}, new_acl=${hasNewAcl}, old_acl=${hasOldAcl})`
            );
          }
        }
      },
      compareAndSetGroup: async (resource): Promise<UnixGroupCompareAndSetResult> => {
        if (resource.kind === 'branch') {
          const row = await select(db, { unix_group: branches.unix_group })
            .from(branches)
            .where(eq(branches.branch_id, resource.id))
            .one();
          if (!row) return 'conflict';
          if (row.unix_group === resource.newGroup) return 'already-updated';
          if (row.unix_group !== resource.unixGroup) return 'conflict';

          await update(db, branches)
            .set({ unix_group: resource.newGroup })
            .where(
              and(eq(branches.branch_id, resource.id), eq(branches.unix_group, resource.unixGroup))
            )
            .run();
          const verified = await select(db, { unix_group: branches.unix_group })
            .from(branches)
            .where(eq(branches.branch_id, resource.id))
            .one();
          return verified?.unix_group === resource.newGroup ? 'updated' : 'conflict';
        }

        const row = await select(db, { unix_group: repos.unix_group })
          .from(repos)
          .where(eq(repos.repo_id, resource.id))
          .one();
        if (!row) return 'conflict';
        if (row.unix_group === resource.newGroup) return 'already-updated';
        if (row.unix_group !== resource.unixGroup) return 'conflict';

        await update(db, repos)
          .set({ unix_group: resource.newGroup })
          .where(and(eq(repos.repo_id, resource.id), eq(repos.unix_group, resource.unixGroup)))
          .run();
        const verified = await select(db, { unix_group: repos.unix_group })
          .from(repos)
          .where(eq(repos.repo_id, resource.id))
          .one();
        return verified?.unix_group === resource.newGroup ? 'updated' : 'conflict';
      },
      findDatabaseReferences: async (groupName) => {
        const [branchRefs, repoRefs] = await Promise.all([
          select(db, { id: branches.branch_id })
            .from(branches)
            .where(eq(branches.unix_group, groupName))
            .all(),
          select(db, { id: repos.repo_id })
            .from(repos)
            .where(eq(repos.unix_group, groupName))
            .all(),
        ]);
        return [
          ...branchRefs.map((row: { id: string }) => `branch:${row.id}`),
          ...repoRefs.map((row: { id: string }) => `repo:${row.id}`),
        ];
      },
      findManagedRootsUsingGroup: async (groupName) => {
        const paths = new Set<string>();
        for (const branch of branchRows) {
          if (branch.data?.path && existsSync(branch.data.path)) paths.add(branch.data.path);
        }
        for (const repo of repoRows) {
          const path = repo.data?.local_path;
          if (!path || !existsSync(path)) continue;
          paths.add(path);
          const gitPath = join(path, '.git');
          if (existsSync(gitPath)) paths.add(gitPath);
        }

        const references: string[] = [];
        for (const path of paths) {
          const state = await inspectPath(path);
          if (
            state.group === groupName ||
            state.acl.some(
              (line) =>
                line.startsWith(`group:${groupName}:`) ||
                line.startsWith(`default:group:${groupName}:`)
            )
          ) {
            references.push(path);
          }
        }
        return references;
      },
      groupExists: (groupName) => executor.check(UnixGroupCommands.groupExists(groupName)),
      deleteGroup: async (groupName) => {
        await executor.exec(UnixGroupCommands.deleteGroup(groupName));
      },
    });

    this.log(chalk.bold('\nSummary'));
    this.log(`Rows migrated: ${result.migrated}`);
    this.log(`Legacy groups deleted: ${result.groupsDeleted}`);
    this.log(`Legacy groups retained: ${result.retained.length}`);
    this.log(`Errors: ${result.errors.length}`);

    if (result.retained.length > 0) {
      for (const retained of result.retained) {
        this.log(chalk.yellow(`  ${retained.group}: ${retained.reason}`));
      }
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        this.log(chalk.red(`  ${error.resource}: ${error.message}`));
      }
      this.error(
        'Migration completed with errors. Fix the reported issue and rerun the same command; completed steps are idempotent.'
      );
    }
  }
}
