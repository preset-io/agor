import type {
  BoardCapabilityPolicies,
  BoardID,
  BranchCapabilityPolicy,
  BranchID,
  BranchPermissionConfig,
  CapabilityPolicy,
  CapabilityPolicyCapability,
  CapabilityPolicyEntry,
  CapabilityPolicyFsAccess,
  CapabilityPolicyPresetId,
  CapabilityPolicyPrincipalRef,
  CapabilityPolicyWorkspacePreferences,
  EffectiveCapabilityPolicyAccess,
  GroupID,
  SessionPromptAuthority,
  SessionSdkHomeScope,
  UserID,
  UUID,
} from '@agor/core/types';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import {
  CAPABILITY_POLICY_SCHEMA_VERSION,
  CAPABILITY_POLICY_SESSION_SHARING_KEY,
  CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE,
  capabilityPolicyPresetCapabilities,
  resolveCapabilityPolicyAccess,
  validateCapabilityPolicyDraft,
} from '../../types/capability-policy';
import type { Database } from '../client';
import {
  deleteFrom,
  insert,
  lockRowForUpdate,
  runDatabaseTransaction,
  select,
  update,
} from '../database-wrapper';
import {
  appVariables,
  boardAccessEntries,
  boardAccessPolicies,
  boards,
  branches,
  branchPermissionConfigs,
  branchPermissionEntries,
  groupMemberships,
  groups,
  users,
} from '../schema';
import { currentTenantInsert, EntityNotFoundError, RepositoryError } from './base';

const EMPTY_BOARD_POLICY: CapabilityPolicy = {
  schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
  policy_kind: 'board_access',
  sharing_mode: 'private',
  entries: [],
  others: { preset: 'none', capabilities: [], fs_access: 'none' },
};

const EMPTY_BRANCH_CONFIG: BranchPermissionConfig = {
  access: {
    schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
    policy_kind: 'branch_access',
    sharing_mode: 'private',
    entries: [],
    others: { preset: 'none', capabilities: [], fs_access: 'none' },
  },
  allow_shared_session_prompts: false,
};

function assertPolicy(policy: CapabilityPolicy, kind: CapabilityPolicy['policy_kind']): void {
  if (policy.schema_version !== CAPABILITY_POLICY_SCHEMA_VERSION || policy.policy_kind !== kind) {
    throw new RepositoryError(`Expected ${kind} capability policy schema version 1`);
  }
  const issues = validateCapabilityPolicyDraft(policy);
  if (issues.length > 0) throw new RepositoryError(issues.map((issue) => issue.message).join(' '));
}

function assertConfig(config: BranchPermissionConfig): void {
  assertPolicy(config.access, 'branch_access');
  if (typeof config.allow_shared_session_prompts !== 'boolean') {
    throw new RepositoryError('Shared session prompting must be enabled or disabled explicitly');
  }
}

function rowPrincipal(row: {
  user_id: string | null;
  group_id: string | null;
}): CapabilityPolicyPrincipalRef {
  if (row.user_id && !row.group_id) {
    return { principal_type: 'user', user_id: row.user_id as UserID };
  }
  if (row.group_id && !row.user_id) {
    return { principal_type: 'group', group_id: row.group_id as GroupID };
  }
  throw new RepositoryError('Capability entry must reference exactly one user or group');
}

function entryInsert(entry: CapabilityPolicyEntry, now: Date) {
  const principal = entry.principal;
  return {
    // Entry IDs are row-local implementation details, not stable API
    // identities. Mint them server-side so copying a board template into a
    // branch override cannot collide with the source config's primary keys.
    entry_id: generateId(),
    user_id: principal.principal_type === 'user' ? principal.user_id : null,
    group_id: principal.principal_type === 'group' ? principal.group_id : null,
    role: entry.preset,
    created_at: now,
    updated_at: now,
  };
}

function capabilitiesForStoredRole(
  kind: CapabilityPolicy['policy_kind'],
  role: string,
  fsAccess: CapabilityPolicyFsAccess = 'none'
): CapabilityPolicyCapability[] {
  const capabilities = capabilityPolicyPresetCapabilities(
    kind,
    role as CapabilityPolicyPresetId,
    fsAccess
  );
  if (!capabilities) {
    throw new RepositoryError(`Invalid ${kind} role ${role}`);
  }
  return capabilities;
}

function legacyCan(access: EffectiveCapabilityPolicyAccess): 'none' | 'view' | 'session' | 'all' {
  if (access.capabilities.includes('branch.policy.manage')) return 'all';
  if (
    access.capabilities.includes('sessions.create') &&
    access.capabilities.includes('sessions.prompt_own')
  ) {
    return 'session';
  }
  return access.capabilities.includes('branch.view') ? 'view' : 'none';
}

function policyPrincipalIds(policy: CapabilityPolicy): { userIds: string[]; groupIds: string[] } {
  const userIds: string[] = [];
  const groupIds: string[] = [];
  for (const entry of policy.entries) {
    if (entry.principal.principal_type === 'user') userIds.push(entry.principal.user_id);
    else groupIds.push(entry.principal.group_id);
  }
  return { userIds, groupIds };
}

async function assertPrincipalsExist(db: Database, policies: CapabilityPolicy[]): Promise<void> {
  const userIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const policy of policies) {
    const ids = policyPrincipalIds(policy);
    for (const id of ids.userIds) userIds.add(id);
    for (const id of ids.groupIds) groupIds.add(id);
  }
  if (userIds.size > 0) {
    const rows = await select(db, { user_id: users.user_id })
      .from(users)
      .where(inArray(users.user_id, [...userIds]))
      .all();
    if (rows.length !== userIds.size) {
      throw new RepositoryError('Every permission user must be an existing workspace member');
    }
  }
  if (groupIds.size > 0) {
    const rows = await select(db, { group_id: groups.group_id })
      .from(groups)
      .where(inArray(groups.group_id, [...groupIds]))
      .all();
    if (rows.length !== groupIds.size) {
      throw new RepositoryError('Every permission group must belong to this workspace');
    }
  }
}

export class CapabilityPolicyRepository {
  constructor(private db: Database) {}

  private initialBoardPolicies(
    ownerId: UserID,
    options: {
      shared?: boolean;
      defaultOthersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all';
      defaultOthersFsAccess?: CapabilityPolicyFsAccess;
    }
  ): BoardCapabilityPolicies {
    const shared = options.shared === true;
    const defaultPreset =
      options.defaultOthersCan === 'none'
        ? 'none'
        : options.defaultOthersCan === 'view'
          ? 'viewer'
          : options.defaultOthersCan === 'all'
            ? 'manager'
            : 'collaborator';
    const defaultFsAccess =
      defaultPreset === 'none' ? 'none' : (options.defaultOthersFsAccess ?? 'read');
    const boardPolicy: CapabilityPolicy = shared
      ? {
          ...EMPTY_BOARD_POLICY,
          sharing_mode: 'shared',
          others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
        }
      : EMPTY_BOARD_POLICY;
    const branchConfig: BranchPermissionConfig = shared
      ? {
          ...EMPTY_BRANCH_CONFIG,
          access: {
            ...EMPTY_BRANCH_CONFIG.access,
            sharing_mode: 'shared',
            others: {
              preset: defaultPreset,
              capabilities:
                capabilityPolicyPresetCapabilities(
                  'branch_access',
                  defaultPreset,
                  defaultFsAccess
                ) ?? [],
              fs_access: defaultFsAccess,
            },
          },
        }
      : EMPTY_BRANCH_CONFIG;
    return {
      primary_owner_user_id: ownerId,
      board_access_revision: 0,
      branch_template_revision: 0,
      board_access: boardPolicy,
      branch_template: branchConfig,
    };
  }

  /**
   * Create the two mandatory board policies on an existing transaction.
   * BoardRepository uses this so a board can never become visible without its
   * corresponding authorization rows (or vice versa).
   */
  async initializeBoardInTransaction(
    tx: Database,
    boardId: BoardID,
    ownerId: UserID,
    options: {
      shared?: boolean;
      defaultOthersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all';
      defaultOthersFsAccess?: CapabilityPolicyFsAccess;
    } = {}
  ): Promise<void> {
    const value = this.initialBoardPolicies(ownerId, options);
    const board = await select(tx, { owner: boards.primary_owner_user_id })
      .from(boards)
      .where(eq(boards.board_id, boardId))
      .one();
    if (!board) throw new EntityNotFoundError('Board', boardId);
    if (board.owner !== ownerId) throw new RepositoryError('Primary ownership is immutable');

    const now = new Date();
    await insert(tx, boardAccessPolicies)
      .values({
        ...currentTenantInsert(),
        board_id: boardId,
        schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
        sharing_mode: value.board_access.sharing_mode,
        others_role: value.board_access.others.preset,
        revision: 1,
        // The resource's created_by field is the authoritative creation audit.
        // Keep this nullable because low-level imports may preserve a logical
        // owner whose user row is materialized separately.
        updated_by: null,
        created_at: now,
        updated_at: now,
      })
      .run();
    await this.writeBranchConfig(tx, { board_id: boardId }, value.branch_template, null);
  }

  async initializeBoard(
    boardId: BoardID,
    ownerId: UserID,
    options: {
      shared?: boolean;
      defaultOthersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all';
      defaultOthersFsAccess?: CapabilityPolicyFsAccess;
    } = {}
  ): Promise<void> {
    await runDatabaseTransaction(
      this.db,
      (tx) => this.initializeBoardInTransaction(tx, boardId, ownerId, options),
      { sqliteImmediate: true }
    );
  }

  /** Create a branch override inside the branch insert transaction. */
  async initializeBranchOverrideInTransaction(
    tx: Database,
    branchId: BranchID,
    ownerId: UserID,
    options: {
      othersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all';
      othersFsAccess?: CapabilityPolicyFsAccess;
    } = {}
  ): Promise<void> {
    const branch = await select(tx, { owner: branches.primary_owner_user_id })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();
    if (!branch) throw new EntityNotFoundError('Branch', branchId);
    if (branch.owner !== ownerId) throw new RepositoryError('Primary ownership is immutable');
    const preset =
      options.othersCan === 'view'
        ? 'viewer'
        : options.othersCan === 'all'
          ? 'manager'
          : options.othersCan === 'session' || options.othersCan === 'prompt'
            ? 'collaborator'
            : 'none';
    const fsAccess = preset === 'none' ? 'none' : (options.othersFsAccess ?? 'read');
    const config: BranchPermissionConfig =
      preset === 'none'
        ? EMPTY_BRANCH_CONFIG
        : {
            access: {
              ...EMPTY_BRANCH_CONFIG.access,
              sharing_mode: 'shared',
              others: {
                preset,
                capabilities:
                  capabilityPolicyPresetCapabilities('branch_access', preset, fsAccess) ?? [],
                fs_access: fsAccess,
              },
            },
            allow_shared_session_prompts: false,
          };
    await this.writeBranchConfig(tx, { branch_id: branchId }, config, null);
  }

  async initializeBranchOverride(
    branchId: BranchID,
    ownerId: UserID,
    options: {
      othersCan?: 'none' | 'view' | 'session' | 'prompt' | 'all';
      othersFsAccess?: CapabilityPolicyFsAccess;
    } = {}
  ): Promise<void> {
    await runDatabaseTransaction(
      this.db,
      (tx) => this.initializeBranchOverrideInTransaction(tx, branchId, ownerId, options),
      { sqliteImmediate: true }
    );
  }

  private async loadPolicyEntries(
    kind: 'board' | 'branch',
    id: string
  ): Promise<CapabilityPolicyEntry[]> {
    if (kind === 'board') {
      const rows = await select(this.db)
        .from(boardAccessEntries)
        .where(eq(boardAccessEntries.board_id, id))
        .all();
      return rows.map(
        (row: {
          entry_id: string;
          user_id: string | null;
          group_id: string | null;
          role: string;
        }) => ({
          entry_id: row.entry_id as UUID,
          principal: rowPrincipal(row),
          preset: row.role as CapabilityPolicyPresetId,
          capabilities: capabilitiesForStoredRole('board_access', row.role),
          fs_access: 'none',
        })
      );
    }
    const rows = await select(this.db)
      .from(branchPermissionEntries)
      .where(eq(branchPermissionEntries.config_id, id))
      .all();
    return rows.map(
      (row: {
        entry_id: string;
        user_id: string | null;
        group_id: string | null;
        role: string;
        fs_access: string;
      }) => ({
        entry_id: row.entry_id as UUID,
        principal: rowPrincipal(row),
        preset: row.role as CapabilityPolicyPresetId,
        capabilities: capabilitiesForStoredRole(
          'branch_access',
          row.role,
          row.fs_access as CapabilityPolicyFsAccess
        ),
        fs_access: row.fs_access as CapabilityPolicyFsAccess,
      })
    );
  }

  private async loadBranchConfig(configId: string): Promise<BranchPermissionConfig> {
    const row = await select(this.db)
      .from(branchPermissionConfigs)
      .where(eq(branchPermissionConfigs.config_id, configId))
      .one();
    if (!row) throw new RepositoryError(`Missing branch permission config ${configId}`);
    const entries = await this.loadPolicyEntries('branch', configId);
    return {
      access: {
        schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
        policy_kind: 'branch_access',
        sharing_mode: row.sharing_mode as CapabilityPolicy['sharing_mode'],
        entries,
        others: {
          preset: row.others_role as CapabilityPolicyPresetId,
          capabilities: capabilitiesForStoredRole(
            'branch_access',
            row.others_role,
            row.others_fs_access as CapabilityPolicyFsAccess
          ),
          fs_access: row.others_fs_access as CapabilityPolicyFsAccess,
        },
      },
      allow_shared_session_prompts: Boolean(row.allow_shared_session_prompts),
    };
  }

  async getBoardPolicies(boardId: BoardID): Promise<BoardCapabilityPolicies> {
    const board = await select(this.db, {
      board_id: boards.board_id,
      primary_owner_user_id: boards.primary_owner_user_id,
    })
      .from(boards)
      .where(eq(boards.board_id, boardId))
      .one();
    if (!board) throw new EntityNotFoundError('Board', boardId);
    const policy = await select(this.db)
      .from(boardAccessPolicies)
      .where(eq(boardAccessPolicies.board_id, boardId))
      .one();
    const template = await select(this.db)
      .from(branchPermissionConfigs)
      .where(eq(branchPermissionConfigs.board_id, boardId))
      .one();
    if (!policy || !template)
      throw new RepositoryError(`Board ${boardId} has no capability policy`);
    return {
      primary_owner_user_id: board.primary_owner_user_id as UserID,
      board_access_revision: policy.revision,
      branch_template_revision: template.revision,
      board_access: {
        schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
        policy_kind: 'board_access',
        sharing_mode: policy.sharing_mode as CapabilityPolicy['sharing_mode'],
        entries: await this.loadPolicyEntries('board', boardId),
        others: {
          preset: policy.others_role as CapabilityPolicyPresetId,
          capabilities: capabilitiesForStoredRole('board_access', policy.others_role),
          fs_access: 'none',
        },
      },
      branch_template: await this.loadBranchConfig(template.config_id),
    };
  }

  async getBranchPolicy(branchId: BranchID): Promise<BranchCapabilityPolicy> {
    const branch = await select(this.db, {
      branch_id: branches.branch_id,
      board_id: branches.board_id,
      primary_owner_user_id: branches.primary_owner_user_id,
      permission_binding: branches.permission_binding,
    })
      .from(branches)
      .where(eq(branches.branch_id, branchId))
      .one();
    if (!branch) throw new EntityNotFoundError('Branch', branchId);
    if (branch.permission_binding === 'inherit') {
      if (!branch.board_id) throw new RepositoryError('An inherited branch must belong to a board');
      const template = await select(this.db)
        .from(branchPermissionConfigs)
        .where(eq(branchPermissionConfigs.board_id, branch.board_id))
        .one();
      if (!template) throw new RepositoryError(`Board ${branch.board_id} has no branch template`);
      return {
        primary_owner_user_id: branch.primary_owner_user_id as UserID,
        revision: template.revision,
        binding_mode: 'inherit',
        inherited_from_board_id: branch.board_id as BoardID,
        inherited_config: await this.loadBranchConfig(template.config_id),
      };
    }
    const override = await select(this.db)
      .from(branchPermissionConfigs)
      .where(eq(branchPermissionConfigs.branch_id, branchId))
      .one();
    if (!override) throw new RepositoryError(`Branch ${branchId} has no override policy`);
    return {
      primary_owner_user_id: branch.primary_owner_user_id as UserID,
      revision: override.revision,
      binding_mode: 'override',
      inherited_from_board_id: (branch.board_id as BoardID | null) ?? undefined,
      inherited_config: branch.board_id
        ? await this.loadBoardTemplateIfPresent(branch.board_id)
        : undefined,
      override_config: await this.loadBranchConfig(override.config_id),
    };
  }

  private async loadBoardTemplateIfPresent(
    boardId: string
  ): Promise<BranchPermissionConfig | undefined> {
    const row = await select(this.db)
      .from(branchPermissionConfigs)
      .where(eq(branchPermissionConfigs.board_id, boardId))
      .one();
    return row ? this.loadBranchConfig(row.config_id) : undefined;
  }

  private async writeBranchConfig(
    tx: Database,
    target: { board_id?: BoardID; branch_id?: BranchID },
    config: BranchPermissionConfig,
    actorId: UserID | null,
    existingConfigId?: string,
    expectedRevision?: number
  ): Promise<string> {
    assertConfig(config);
    const now = new Date();
    const configId = existingConfigId ?? generateId();
    if (existingConfigId) {
      const updated = await update(tx, branchPermissionConfigs)
        .set({
          sharing_mode: config.access.sharing_mode,
          others_role: config.access.others.preset,
          others_fs_access: config.access.others.fs_access,
          allow_shared_session_prompts: config.allow_shared_session_prompts,
          revision: sql`${branchPermissionConfigs.revision} + 1`,
          updated_by: actorId,
          updated_at: now,
        })
        .where(
          and(
            eq(branchPermissionConfigs.config_id, configId),
            expectedRevision === undefined
              ? undefined
              : eq(branchPermissionConfigs.revision, expectedRevision)
          )
        )
        .run();
      if (expectedRevision !== undefined && updated.rowsAffected !== 1) {
        throw new RepositoryError('Permission configuration changed; reload before saving');
      }
      await deleteFrom(tx, branchPermissionEntries)
        .where(eq(branchPermissionEntries.config_id, configId))
        .run();
    } else {
      await insert(tx, branchPermissionConfigs)
        .values({
          ...currentTenantInsert(),
          config_id: configId,
          board_id: target.board_id ?? null,
          branch_id: target.branch_id ?? null,
          schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
          sharing_mode: config.access.sharing_mode,
          others_role: config.access.others.preset,
          others_fs_access: config.access.others.fs_access,
          allow_shared_session_prompts: config.allow_shared_session_prompts,
          revision: 1,
          updated_by: actorId,
          created_at: now,
          updated_at: now,
        })
        .run();
    }
    if (config.access.entries.length > 0) {
      await insert(tx, branchPermissionEntries)
        .values(
          config.access.entries.map((entry) => ({
            ...currentTenantInsert(),
            ...entryInsert(entry, now),
            config_id: configId,
            fs_access: entry.fs_access,
          }))
        )
        .run();
    }
    return configId;
  }

  async replaceBoardPolicies(
    boardId: BoardID,
    value: BoardCapabilityPolicies,
    actorId: UserID,
    options: { initialize?: boolean } = {}
  ): Promise<BoardCapabilityPolicies> {
    assertPolicy(value.board_access, 'board_access');
    assertConfig(value.branch_template);
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        await lockRowForUpdate(tx, this.db, boards, eq(boards.board_id, boardId));
        await assertPrincipalsExist(tx, [value.board_access, value.branch_template.access]);
        const board = await select(tx, { owner: boards.primary_owner_user_id })
          .from(boards)
          .where(eq(boards.board_id, boardId))
          .one();
        if (!board) throw new EntityNotFoundError('Board', boardId);
        if (board.owner !== value.primary_owner_user_id)
          throw new RepositoryError('Primary ownership is immutable');
        const now = new Date();
        const currentPolicy = await select(tx)
          .from(boardAccessPolicies)
          .where(eq(boardAccessPolicies.board_id, boardId))
          .one();
        if (currentPolicy) {
          if (!options.initialize && value.board_access_revision !== currentPolicy.revision) {
            throw new RepositoryError('Board access policy changed; reload before saving');
          }
          const updated = await update(tx, boardAccessPolicies)
            .set({
              sharing_mode: value.board_access.sharing_mode,
              others_role: value.board_access.others.preset,
              revision: currentPolicy.revision + 1,
              updated_by: actorId,
              updated_at: now,
            })
            .where(
              and(
                eq(boardAccessPolicies.board_id, boardId),
                eq(boardAccessPolicies.revision, currentPolicy.revision)
              )
            )
            .run();
          if (updated.rowsAffected !== 1) {
            throw new RepositoryError('Board access policy changed; reload before saving');
          }
          await deleteFrom(tx, boardAccessEntries)
            .where(eq(boardAccessEntries.board_id, boardId))
            .run();
        } else {
          if (!options.initialize)
            throw new RepositoryError(`Board ${boardId} has no capability policy`);
          await insert(tx, boardAccessPolicies)
            .values({
              ...currentTenantInsert(),
              board_id: boardId,
              schema_version: CAPABILITY_POLICY_SCHEMA_VERSION,
              sharing_mode: value.board_access.sharing_mode,
              others_role: value.board_access.others.preset,
              revision: 1,
              updated_by: actorId,
              created_at: now,
              updated_at: now,
            })
            .run();
        }
        if (value.board_access.entries.length > 0) {
          await insert(tx, boardAccessEntries)
            .values(
              value.board_access.entries.map((entry) => ({
                ...currentTenantInsert(),
                ...entryInsert(entry, now),
                board_id: boardId,
              }))
            )
            .run();
        }
        const currentTemplate = await select(tx)
          .from(branchPermissionConfigs)
          .where(eq(branchPermissionConfigs.board_id, boardId))
          .one();
        if (
          currentTemplate &&
          !options.initialize &&
          value.branch_template_revision !== currentTemplate.revision
        ) {
          throw new RepositoryError('Board branch defaults changed; reload before saving');
        }
        await this.writeBranchConfig(
          tx,
          { board_id: boardId },
          value.branch_template,
          actorId,
          currentTemplate?.config_id,
          currentTemplate?.revision
        );
      },
      { sqliteImmediate: true }
    );
    return this.getBoardPolicies(boardId);
  }

  async replaceBranchPolicy(
    branchId: BranchID,
    value: BranchCapabilityPolicy,
    actorId: UserID,
    options: { initialize?: boolean } = {}
  ): Promise<BranchCapabilityPolicy> {
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        const initialBranch = await select(tx, { board_id: branches.board_id })
          .from(branches)
          .where(eq(branches.branch_id, branchId))
          .one();
        if (!initialBranch) throw new EntityNotFoundError('Branch', branchId);
        if (initialBranch.board_id) {
          await lockRowForUpdate(tx, this.db, boards, eq(boards.board_id, initialBranch.board_id));
        }
        await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, branchId));
        const submittedConfig =
          value.binding_mode === 'override' ? value.override_config : value.inherited_config;
        if (submittedConfig) {
          await assertPrincipalsExist(tx, [submittedConfig.access]);
        }
        const branch = await select(tx, {
          owner: branches.primary_owner_user_id,
          board_id: branches.board_id,
          permission_binding: branches.permission_binding,
        })
          .from(branches)
          .where(eq(branches.branch_id, branchId))
          .one();
        if (!branch) throw new EntityNotFoundError('Branch', branchId);
        if (branch.board_id !== initialBranch.board_id) {
          throw new RepositoryError('Branch board changed; reload before saving permissions');
        }
        if (
          value.inherited_from_board_id !== undefined &&
          value.inherited_from_board_id !== branch.board_id
        ) {
          throw new RepositoryError('Branch board changed; reload before saving permissions');
        }
        if (branch.owner !== value.primary_owner_user_id)
          throw new RepositoryError('Primary ownership is immutable');
        if (value.binding_mode === 'inherit' && !branch.board_id) {
          throw new RepositoryError('A branch without a board cannot inherit permissions');
        }
        const current = await select(tx)
          .from(branchPermissionConfigs)
          .where(eq(branchPermissionConfigs.branch_id, branchId))
          .one();
        if (value.binding_mode === 'inherit') {
          const template = await select(tx)
            .from(branchPermissionConfigs)
            .where(eq(branchPermissionConfigs.board_id, branch.board_id!))
            .one();
          if (!template) {
            throw new RepositoryError(`Board ${branch.board_id} has no branch template`);
          }
          if (
            !options.initialize &&
            branch.permission_binding === 'inherit' &&
            value.revision !== template.revision
          ) {
            throw new RepositoryError('Board branch defaults changed; reload before saving');
          }
          await update(tx, branches)
            .set({ permission_binding: 'inherit' })
            .where(eq(branches.branch_id, branchId))
            .run();
          if (current)
            await deleteFrom(tx, branchPermissionConfigs)
              .where(eq(branchPermissionConfigs.config_id, current.config_id))
              .run();
          return;
        }
        const config = value.override_config ?? value.inherited_config;
        if (!config)
          throw new RepositoryError('Override mode requires a complete permission config');
        if (current && !options.initialize && value.revision !== current.revision) {
          throw new RepositoryError('Branch permissions changed; reload before saving');
        }
        if (!current && !options.initialize && value.override_config == null) {
          throw new RepositoryError('Override mode requires a complete permission config');
        }
        if (!current && !options.initialize && branch.board_id) {
          const template = await select(tx)
            .from(branchPermissionConfigs)
            .where(eq(branchPermissionConfigs.board_id, branch.board_id))
            .one();
          if (!template) {
            throw new RepositoryError(`Board ${branch.board_id} has no branch template`);
          }
          if (value.revision !== template.revision) {
            throw new RepositoryError('Board branch defaults changed; reload before overriding');
          }
        }
        await update(tx, branches)
          .set({ permission_binding: 'override' })
          .where(eq(branches.branch_id, branchId))
          .run();
        await this.writeBranchConfig(
          tx,
          { branch_id: branchId },
          config,
          actorId,
          current?.config_id,
          current?.revision
        );
      },
      { sqliteImmediate: true }
    );
    return this.getBranchPolicy(branchId);
  }

  /**
   * Preserve branch authorization when a board is hard-deleted.
   *
   * An inherited branch cannot outlive its template. Before the board row is
   * removed (which clears branches.board_id), materialize the complete current
   * template — access plus the shared-session switch — as an override
   * for each inherited branch. The caller must run this in the same transaction
   * as the board delete.
   */
  async materializeInheritedBranchesBeforeBoardDeleteInTransaction(
    tx: Database,
    boardId: BoardID,
    actorId: UserID | null = null
  ): Promise<number> {
    const scoped = new CapabilityPolicyRepository(tx);
    await lockRowForUpdate(tx, this.db, boards, eq(boards.board_id, boardId));
    const template = await select(tx)
      .from(branchPermissionConfigs)
      .where(eq(branchPermissionConfigs.board_id, boardId))
      .one();
    if (!template) throw new RepositoryError(`Board ${boardId} has no branch template`);
    const config = await scoped.loadBranchConfig(template.config_id);
    await lockRowForUpdate(
      tx,
      this.db,
      branchPermissionConfigs,
      eq(branchPermissionConfigs.config_id, template.config_id)
    );
    const inherited = await select(tx, { branch_id: branches.branch_id })
      .from(branches)
      .where(and(eq(branches.board_id, boardId), eq(branches.permission_binding, 'inherit')))
      .all();

    for (const branch of inherited) {
      await lockRowForUpdate(tx, this.db, branches, eq(branches.branch_id, branch.branch_id));
      const existing = await select(tx, {
        config_id: branchPermissionConfigs.config_id,
        revision: branchPermissionConfigs.revision,
      })
        .from(branchPermissionConfigs)
        .where(eq(branchPermissionConfigs.branch_id, branch.branch_id))
        .one();
      await scoped.writeBranchConfig(
        tx,
        { branch_id: branch.branch_id as BranchID },
        structuredClone(config),
        actorId,
        existing?.config_id,
        existing?.revision
      );
      await update(tx, branches)
        .set({ permission_binding: 'override', permission_source: 'override' })
        .where(eq(branches.branch_id, branch.branch_id))
        .run();
    }
    return inherited.length;
  }

  async resolveBoardAccess(
    boardId: BoardID,
    userId: UserID
  ): Promise<EffectiveCapabilityPolicyAccess> {
    const value = await this.getBoardPolicies(boardId);
    const userExists = await this.userExists(userId);
    const groupIds = await this.activeGroupIds(userId);
    return resolveCapabilityPolicyAccess({
      policy: value.board_access,
      primary_owner_user_id: value.primary_owner_user_id,
      user_id: userId,
      user_status: userExists ? 'active' : 'deleted',
      active_group_ids: groupIds,
    });
  }

  async resolveBranchAccess(
    branchId: BranchID,
    userId: UserID
  ): Promise<EffectiveCapabilityPolicyAccess> {
    const value = await this.getBranchPolicy(branchId);
    const config =
      value.binding_mode === 'inherit' ? value.inherited_config : value.override_config;
    if (!config) throw new RepositoryError(`Branch ${branchId} has no effective permission config`);
    const userExists = await this.userExists(userId);
    return resolveCapabilityPolicyAccess({
      policy: config.access,
      primary_owner_user_id: value.primary_owner_user_id,
      user_id: userId,
      user_status: userExists ? 'active' : 'deleted',
      active_group_ids: await this.activeGroupIds(userId),
    });
  }

  async resolveLegacyBranchAccess(branchId: BranchID, userId: UserID) {
    const access = await this.resolveBranchAccess(branchId, userId);
    return {
      can: legacyCan(access),
      fs_access: access.fs_access,
      is_owner: access.is_primary_owner,
      source:
        access.source === 'primary_owner'
          ? 'owner'
          : access.source === 'group'
            ? 'group'
            : 'others',
      group_ids: access.group_ids,
    } as const;
  }

  private async activeGroupIds(userId: UserID): Promise<GroupID[]> {
    const rows = await select(this.db, { group_id: groupMemberships.group_id })
      .from(groupMemberships)
      .innerJoin(
        groups,
        and(eq(groups.group_id, groupMemberships.group_id), eq(groups.archived, false))
      )
      .where(eq(groupMemberships.user_id, userId))
      .all();
    return rows.map((row: { group_id: string }) => row.group_id as GroupID);
  }

  private async userExists(userId: UserID): Promise<boolean> {
    const row = await select(this.db, { user_id: users.user_id })
      .from(users)
      .where(eq(users.user_id, userId))
      .one();
    return Boolean(row);
  }

  async getWorkspacePreferences(): Promise<CapabilityPolicyWorkspacePreferences> {
    const row = await select(this.db, { value_text: appVariables.value_text })
      .from(appVariables)
      .where(
        and(
          eq(appVariables.namespace, CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE),
          eq(appVariables.key, CAPABILITY_POLICY_SESSION_SHARING_KEY)
        )
      )
      .one();
    return { session_sharing_enabled: row?.value_text === 'true' };
  }

  async setWorkspacePreferences(
    value: CapabilityPolicyWorkspacePreferences,
    actorId: UserID
  ): Promise<CapabilityPolicyWorkspacePreferences> {
    const now = new Date();
    await runDatabaseTransaction(
      this.db,
      async (tx) => {
        // Insert-if-absent followed by an atomic update avoids the absent-row
        // race on both SQLite and PostgreSQL.
        await insert(tx, appVariables)
          .values({
            ...currentTenantInsert(),
            variable_id: generateId(),
            namespace: CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE,
            key: CAPABILITY_POLICY_SESSION_SHARING_KEY,
            value_text: 'false',
            value_encrypted: null,
            is_encrypted: false,
            content_type: 'text/plain',
            metadata: null,
            updated_by: actorId,
            created_at: now,
            updated_at: now,
          })
          .onConflictDoNothing()
          .run();
        await update(tx, appVariables)
          .set({
            value_text: String(value.session_sharing_enabled),
            updated_by: actorId,
            updated_at: now,
          })
          .where(
            and(
              eq(appVariables.namespace, CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE),
              eq(appVariables.key, CAPABILITY_POLICY_SESSION_SHARING_KEY)
            )
          )
          .run();

        if (!value.session_sharing_enabled) {
          // Revocation is deliberately sticky: disabling the tenant gate also
          // clears every narrower opt-in, so re-enabling the feature cannot
          // silently reopen branches based on stale configuration.
          await update(tx, branchPermissionConfigs)
            .set({
              allow_shared_session_prompts: false,
              revision: sql`${branchPermissionConfigs.revision} + 1`,
              updated_by: actorId,
              updated_at: now,
            })
            .where(eq(branchPermissionConfigs.allow_shared_session_prompts, true))
            .run();
        }
      },
      { sqliteImmediate: true }
    );
    return value;
  }

  async resolveSessionPromptAuthority(input: {
    branch_id: BranchID;
    caller_user_id: UserID;
    session_owner_user_id: UserID;
    session_sdk_home_scope: SessionSdkHomeScope;
  }): Promise<SessionPromptAuthority> {
    const access = await this.resolveBranchAccess(input.branch_id, input.caller_user_id);
    const canPromptOwn = access.capabilities.includes('sessions.prompt_own');
    if (input.caller_user_id === input.session_owner_user_id) {
      return canPromptOwn
        ? { allowed: true, execution_user_id: input.caller_user_id, source: 'own_session' }
        : { allowed: false, source: 'denied', denial_reason: 'branch_access_required' };
    }
    if (!access.capabilities.includes('sessions.prompt_own')) {
      return { allowed: false, source: 'denied', denial_reason: 'branch_access_required' };
    }
    if (input.session_sdk_home_scope === 'execution_home') {
      return {
        allowed: false,
        source: 'denied',
        denial_reason: 'execution_home_sharing_disabled',
      };
    }
    const preferences = await this.getWorkspacePreferences();
    if (!preferences.session_sharing_enabled) {
      return {
        allowed: false,
        source: 'denied',
        denial_reason: 'workspace_session_sharing_disabled',
      };
    }
    const policy = await this.getBranchPolicy(input.branch_id);
    const config =
      policy.binding_mode === 'inherit' ? policy.inherited_config : policy.override_config;
    if (!config?.allow_shared_session_prompts) {
      return {
        allowed: false,
        source: 'denied',
        denial_reason: 'branch_session_sharing_disabled',
      };
    }
    return {
      allowed: true,
      execution_user_id: input.caller_user_id,
      source: 'branch_session',
    };
  }

  /** Batch read used by inventory/export surfaces that need only private/shared state. */
  async getBranchSharingModes(
    branchIds: readonly BranchID[]
  ): Promise<Map<BranchID, CapabilityPolicy['sharing_mode']>> {
    if (branchIds.length === 0) return new Map();
    const branchRows = (await select(this.db, {
      branch_id: branches.branch_id,
      board_id: branches.board_id,
      permission_binding: branches.permission_binding,
    })
      .from(branches)
      .where(inArray(branches.branch_id, [...branchIds]))
      .all()) as Array<{
      branch_id: string;
      board_id: string | null;
      permission_binding: 'inherit' | 'override';
    }>;
    const overrideIds = branchRows
      .filter((row) => row.permission_binding === 'override')
      .map((row) => row.branch_id);
    const boardIds = branchRows
      .filter((row) => row.permission_binding === 'inherit' && row.board_id)
      .map((row) => row.board_id as string);
    const predicates = [
      ...(overrideIds.length > 0 ? [inArray(branchPermissionConfigs.branch_id, overrideIds)] : []),
      ...(boardIds.length > 0 ? [inArray(branchPermissionConfigs.board_id, boardIds)] : []),
    ];
    if (predicates.length === 0) return new Map();
    const configRows = (await select(this.db, {
      branch_id: branchPermissionConfigs.branch_id,
      board_id: branchPermissionConfigs.board_id,
      sharing_mode: branchPermissionConfigs.sharing_mode,
    })
      .from(branchPermissionConfigs)
      .where(or(...predicates))
      .all()) as Array<{
      branch_id: string | null;
      board_id: string | null;
      sharing_mode: CapabilityPolicy['sharing_mode'];
    }>;
    const byBranch = new Map(
      configRows.filter((row) => row.branch_id).map((row) => [row.branch_id!, row.sharing_mode])
    );
    const byBoard = new Map(
      configRows.filter((row) => row.board_id).map((row) => [row.board_id!, row.sharing_mode])
    );
    return new Map(
      branchRows.flatMap((row) => {
        const mode =
          row.permission_binding === 'override'
            ? byBranch.get(row.branch_id)
            : row.board_id
              ? byBoard.get(row.board_id)
              : undefined;
        return mode ? [[row.branch_id as BranchID, mode as CapabilityPolicy['sharing_mode']]] : [];
      })
    );
  }
}
