import type { BoardID, GroupID, UserID, UUID } from './id';

/** Canonical board/branch capability-policy contract. */
export const CAPABILITY_POLICY_SCHEMA_VERSION = 1 as const;

/** Durable workspace-preference identifiers used by shared-session policy. */
export const CAPABILITY_POLICY_WORKSPACE_PREFERENCES_NAMESPACE = 'workspace_preferences' as const;
export const CAPABILITY_POLICY_SESSION_SHARING_KEY = 'session_sharing_enabled' as const;

export type CapabilityPolicySchemaVersion = typeof CAPABILITY_POLICY_SCHEMA_VERSION;
export type CapabilityPolicySharingMode = 'private' | 'shared';
export type CapabilityPolicyBindingMode = 'inherit' | 'override';
export type CapabilityPolicyFsAccess = 'none' | 'read' | 'write';
export type CapabilityPolicyKind = 'board_access' | 'branch_access';
export type CapabilityPolicyPrincipalStatus = 'active' | 'inactive' | 'deleted';

export const BOARD_POLICY_CAPABILITIES = [
  'board.view',
  'board.edit',
  'board.attach_branch',
  'board.policy.manage',
] as const;

export const BRANCH_POLICY_CAPABILITIES = [
  'branch.view',
  'sessions.create',
  // Historical identifier retained in the persisted policy contract. It
  // authorizes the caller's own Sessions and, when both sharing switches are
  // enabled, another person's branch-home Session.
  'sessions.prompt_own',
  'sessions.manage_others',
  'branch.manage',
  'environment.control',
  'terminal.open',
  'branch.policy.manage',
] as const;

export type BoardPolicyCapability = (typeof BOARD_POLICY_CAPABILITIES)[number];
export type BranchPolicyCapability = (typeof BRANCH_POLICY_CAPABILITIES)[number];
export type CapabilityPolicyCapability = BoardPolicyCapability | BranchPolicyCapability;

export type CapabilityPolicyPresetId = 'none' | 'viewer' | 'editor' | 'collaborator' | 'manager';

export type CapabilityPolicyPrincipalRef =
  | { principal_type: 'user'; user_id: UserID }
  | { principal_type: 'group'; group_id: GroupID };

export interface CapabilityPolicyEntryDraft {
  entry_id: UUID;
  principal: CapabilityPolicyPrincipalRef;
  preset: CapabilityPolicyPresetId;
  capabilities: CapabilityPolicyCapability[];
  fs_access: CapabilityPolicyFsAccess;
}

/**
 * The one explicit fallback entry. It matches only active
 * same-tenant members with no active direct-user or group entry.
 */
export interface CapabilityPolicyOthersDraft {
  preset: CapabilityPolicyPresetId;
  capabilities: CapabilityPolicyCapability[];
  fs_access: CapabilityPolicyFsAccess;
}

export interface CapabilityPolicyDraft {
  schema_version: CapabilityPolicySchemaVersion;
  policy_kind: CapabilityPolicyKind;
  sharing_mode: CapabilityPolicySharingMode;
  entries: CapabilityPolicyEntryDraft[];
  others: CapabilityPolicyOthersDraft;
}

/** Primary owner belongs to the protected resource, not its reusable policy template. */
export interface ProtectedResourceCapabilityPolicyDraft {
  primary_owner_user_id: UserID;
  policy: CapabilityPolicyDraft;
}

export interface BoardCapabilityPoliciesDraft {
  primary_owner_user_id: UserID;
  board_access_revision?: number;
  branch_template_revision?: number;
  board_access: CapabilityPolicyDraft;
  /** Live access and shared-session defaults inherited by aligned branches. */
  branch_template: BranchPermissionConfigDraft;
}

/**
 * The complete configuration shared by board branch defaults and branch
 * overrides. Binding is deliberately outside this object: a branch either
 * inherits or replaces this entire value.
 */
export interface BranchPermissionConfigDraft {
  access: CapabilityPolicyDraft;
  /**
   * Allow Collaborators and Managers to prompt another person's branch-home
   * Session. The tenant workspace preference is an independent fail-closed
   * gate. Execution-home Sessions are never shareable.
   */
  allow_shared_session_prompts: boolean;
}

/**
 * Tenant-level product gate for shared session prompting.
 *
 * This deliberately lives outside a board or branch policy: a workspace
 * administrator can revoke the feature everywhere. Board and branch Managers
 * may opt individual permission packages in only while this gate is enabled.
 */
export interface CapabilityPolicyWorkspacePreferencesDraft {
  session_sharing_enabled: boolean;
}

/** Persisted API names. Draft aliases remain for form state compatibility. */
export type CapabilityPolicy = CapabilityPolicyDraft;
export type CapabilityPolicyEntry = CapabilityPolicyEntryDraft;
export type CapabilityPolicyOthers = CapabilityPolicyOthersDraft;
export type BoardCapabilityPolicies = BoardCapabilityPoliciesDraft;
export type BranchPermissionConfig = BranchPermissionConfigDraft;
export type BranchCapabilityPolicy = BranchCapabilityPolicyDraft;
export type CapabilityPolicyWorkspacePreferences = CapabilityPolicyWorkspacePreferencesDraft;

export type CapabilityPolicyAccessSource = 'primary_owner' | 'direct_user' | 'group' | 'others';

export interface EffectiveCapabilityPolicyAccess {
  capabilities: CapabilityPolicyCapability[];
  fs_access: CapabilityPolicyFsAccess;
  source: CapabilityPolicyAccessSource;
  /** Every active group that contributed when source is group. */
  group_ids: GroupID[];
  is_primary_owner: boolean;
}

export interface SessionPromptAuthority {
  allowed: boolean;
  /** Identity/home that the executor must use when allowed. */
  execution_user_id?: UserID;
  source: 'own_session' | 'branch_session' | 'denied';
  /** Stable reason used to render safe, actionable denials across transports. */
  denial_reason?:
    | 'branch_access_required'
    | 'execution_home_sharing_disabled'
    | 'workspace_session_sharing_disabled'
    | 'branch_session_sharing_disabled';
}

export interface BranchCapabilityPolicyDraft {
  primary_owner_user_id: UserID;
  /** Revision of the effective template/override returned by the server. */
  revision?: number;
  binding_mode: CapabilityPolicyBindingMode;
  inherited_from_board_id?: BoardID;
  inherited_config?: BranchPermissionConfigDraft;
  override_config?: BranchPermissionConfigDraft;
}

/** Hydrated principal read model for selectors, warnings, and access explanations. */
export interface CapabilityPolicyPrincipalDescriptor {
  principal: CapabilityPolicyPrincipalRef;
  display_name: string;
  secondary_label?: string;
  status: CapabilityPolicyPrincipalStatus;
}

export interface CapabilityPolicyValidationIssue {
  code:
    | 'kind_capability_mismatch'
    | 'missing_dependency'
    | 'duplicate_principal'
    | 'private_has_entries'
    | 'private_has_fallback'
    | 'board_has_filesystem_access'
    | 'filesystem_requires_view'
    | 'terminal_requires_filesystem_access'
    | 'preset_mismatch';
  message: string;
  entry_id?: UUID;
}

const CAPABILITIES_BY_KIND: Readonly<
  Record<CapabilityPolicyKind, readonly CapabilityPolicyCapability[]>
> = {
  board_access: BOARD_POLICY_CAPABILITIES,
  branch_access: BRANCH_POLICY_CAPABILITIES,
};

const CAPABILITY_DEPENDENCIES: Readonly<
  Partial<Record<CapabilityPolicyCapability, readonly CapabilityPolicyCapability[]>>
> = {
  'board.edit': ['board.view'],
  'board.attach_branch': ['board.view'],
  'board.policy.manage': ['board.view', 'board.edit'],
  'sessions.create': ['branch.view'],
  'sessions.prompt_own': ['branch.view', 'sessions.create'],
  'sessions.manage_others': ['branch.view'],
  'branch.manage': ['branch.view'],
  'environment.control': ['branch.view', 'branch.manage'],
  // Terminal remains a low-level evaluator capability, but the product form
  // derives it from Work in own sessions + non-none filesystem access.
  'terminal.open': ['branch.view', 'sessions.create', 'sessions.prompt_own'],
  'branch.policy.manage': ['branch.view', 'branch.manage'],
};

const PRESET_CAPABILITIES: Readonly<
  Record<
    CapabilityPolicyKind,
    Partial<Record<CapabilityPolicyPresetId, readonly CapabilityPolicyCapability[]>>
  >
> = {
  board_access: {
    none: [],
    viewer: ['board.view'],
    editor: ['board.view', 'board.edit', 'board.attach_branch'],
    manager: BOARD_POLICY_CAPABILITIES,
  },
  branch_access: {
    none: [],
    viewer: ['branch.view'],
    collaborator: ['branch.view', 'sessions.create', 'sessions.prompt_own'],
    manager: [
      'branch.view',
      'sessions.create',
      'sessions.prompt_own',
      'sessions.manage_others',
      'branch.manage',
      'environment.control',
      'branch.policy.manage',
    ],
  },
};

/**
 * Canonical product role expansion used by every form, migration adapter, and
 * authorization write validator. Filesystem access remains a separate branch
 * dimension; terminal access is derived from a work-capable role plus non-none
 * filesystem access rather than exposed as another independent choice.
 */
export function capabilityPolicyPresetCapabilities(
  kind: CapabilityPolicyKind,
  preset: CapabilityPolicyPresetId,
  fsAccess: CapabilityPolicyFsAccess = 'none'
): CapabilityPolicyCapability[] | null {
  const base = PRESET_CAPABILITIES[kind][preset];
  if (!base) return null;
  const capabilities = [...base];
  if (
    kind === 'branch_access' &&
    fsAccess !== 'none' &&
    (preset === 'collaborator' || preset === 'manager')
  ) {
    capabilities.push('terminal.open');
  }
  return normalizeCapabilityPolicyCapabilities(kind, capabilities);
}

export function capabilityPolicyPrincipalKey(principal: CapabilityPolicyPrincipalRef): string {
  return principal.principal_type === 'user'
    ? `user:${principal.user_id}`
    : `group:${principal.group_id}`;
}

export function capabilityPolicySupportsFilesystem(kind: CapabilityPolicyKind): boolean {
  return kind === 'branch_access';
}

export function capabilityPolicyDependencies(
  capability: CapabilityPolicyCapability
): readonly CapabilityPolicyCapability[] {
  return CAPABILITY_DEPENDENCIES[capability] ?? [];
}

/**
 * Return a dependency-closed capability set in the canonical order for the
 * selected policy kind. Unknown/cross-kind capabilities are removed.
 */
export function normalizeCapabilityPolicyCapabilities(
  kind: CapabilityPolicyKind,
  capabilities: readonly CapabilityPolicyCapability[]
): CapabilityPolicyCapability[] {
  const allowed = new Set(CAPABILITIES_BY_KIND[kind]);
  const selected = new Set(capabilities.filter((capability) => allowed.has(capability)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const capability of [...selected]) {
      for (const dependency of capabilityPolicyDependencies(capability)) {
        if (!allowed.has(dependency) || selected.has(dependency)) continue;
        selected.add(dependency);
        changed = true;
      }
    }
  }
  return CAPABILITIES_BY_KIND[kind].filter((capability) => selected.has(capability));
}

/** Remove a capability and every selected capability that transitively requires it. */
export function removeCapabilityPolicyCapability(
  kind: CapabilityPolicyKind,
  capabilities: readonly CapabilityPolicyCapability[],
  removed: CapabilityPolicyCapability
): CapabilityPolicyCapability[] {
  const selected = new Set(capabilities);
  selected.delete(removed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const capability of [...selected]) {
      if (
        capabilityPolicyDependencies(capability).some((dependency) => !selected.has(dependency))
      ) {
        selected.delete(capability);
        changed = true;
      }
    }
  }
  return CAPABILITIES_BY_KIND[kind].filter((capability) => selected.has(capability));
}

export function validateCapabilityPolicyDraft(
  policy: CapabilityPolicyDraft
): CapabilityPolicyValidationIssue[] {
  const issues: CapabilityPolicyValidationIssue[] = [];
  const allowed = new Set(CAPABILITIES_BY_KIND[policy.policy_kind]);
  const seenPrincipals = new Set<string>();
  const values: Array<
    Pick<CapabilityPolicyEntryDraft, 'entry_id' | 'preset' | 'capabilities' | 'fs_access'>
  > = [...policy.entries];

  for (const entry of policy.entries) {
    const principalKey = capabilityPolicyPrincipalKey(entry.principal);
    if (seenPrincipals.has(principalKey)) {
      issues.push({
        code: 'duplicate_principal',
        entry_id: entry.entry_id,
        message: 'Each person or group can appear only once.',
      });
    }
    seenPrincipals.add(principalKey);
  }

  values.push({
    entry_id: '00000000-0000-0000-0000-000000000000' as UUID,
    preset: policy.others.preset,
    capabilities: policy.others.capabilities,
    fs_access: policy.others.fs_access,
  });

  for (const value of values) {
    const selected = new Set(value.capabilities);
    const expected = capabilityPolicyPresetCapabilities(
      policy.policy_kind,
      value.preset,
      value.fs_access
    );
    if (
      expected === null ||
      expected.length !== value.capabilities.length ||
      expected.some((capability) => !selected.has(capability))
    ) {
      issues.push({
        code: 'preset_mismatch',
        entry_id: value.entry_id,
        message: 'Role capabilities must match the selected role and file access.',
      });
    }
    for (const capability of value.capabilities) {
      if (!allowed.has(capability)) {
        issues.push({
          code: 'kind_capability_mismatch',
          entry_id: value.entry_id,
          message: `${capability} is not valid for ${policy.policy_kind}.`,
        });
      }
      for (const dependency of capabilityPolicyDependencies(capability)) {
        if (!selected.has(dependency)) {
          issues.push({
            code: 'missing_dependency',
            entry_id: value.entry_id,
            message: `${capability} also requires ${dependency}.`,
          });
        }
      }
    }
    if (!capabilityPolicySupportsFilesystem(policy.policy_kind) && value.fs_access !== 'none') {
      issues.push({
        code: 'board_has_filesystem_access',
        entry_id: value.entry_id,
        message: 'Board access policies cannot grant filesystem access.',
      });
    }
    if (
      policy.policy_kind === 'branch_access' &&
      value.fs_access !== 'none' &&
      !selected.has('branch.view')
    ) {
      issues.push({
        code: 'filesystem_requires_view',
        entry_id: value.entry_id,
        message: 'Read or write file access also requires View branch.',
      });
    }
    if (selected.has('terminal.open') && value.fs_access === 'none') {
      issues.push({
        code: 'terminal_requires_filesystem_access',
        entry_id: value.entry_id,
        message: 'Terminal requires Read or Write filesystem access.',
      });
    }
  }

  if (policy.sharing_mode === 'private') {
    if (policy.entries.length > 0) {
      issues.push({
        code: 'private_has_entries',
        message: 'Private policies cannot contain active user or group entries.',
      });
    }
    if (policy.others.capabilities.length > 0 || policy.others.fs_access !== 'none') {
      issues.push({
        code: 'private_has_fallback',
        message: 'Private policies cannot grant fallback access.',
      });
    }
  }

  return issues;
}

const FS_ACCESS_RANK: Readonly<Record<CapabilityPolicyFsAccess, number>> = {
  none: 0,
  read: 1,
  write: 2,
};

/**
 * Pure capability evaluator shared by repositories and tests.
 *
 * Direct user entries shadow every group entry (including explicit No access).
 * Otherwise active group entries combine additively and filesystem access takes
 * the highest grant. Others applies only when no direct or active-group entry
 * matched. Inactive/deleted users receive no access, including Others.
 */
export function resolveCapabilityPolicyAccess(input: {
  policy: CapabilityPolicyDraft;
  primary_owner_user_id: UserID;
  user_id: UserID;
  user_status: CapabilityPolicyPrincipalStatus;
  active_group_ids?: readonly GroupID[];
}): EffectiveCapabilityPolicyAccess {
  const { policy, primary_owner_user_id: ownerId, user_id: userId } = input;
  if (input.user_status !== 'active') {
    return {
      capabilities: [],
      fs_access: 'none',
      source: 'others',
      group_ids: [],
      is_primary_owner: userId === ownerId,
    };
  }

  if (userId === ownerId) {
    return {
      capabilities: [...CAPABILITIES_BY_KIND[policy.policy_kind]],
      fs_access: policy.policy_kind === 'branch_access' ? 'write' : 'none',
      source: 'primary_owner',
      group_ids: [],
      is_primary_owner: true,
    };
  }

  if (policy.sharing_mode === 'private') {
    return {
      capabilities: [],
      fs_access: 'none',
      source: 'others',
      group_ids: [],
      is_primary_owner: false,
    };
  }

  const direct = policy.entries.find(
    (entry) => entry.principal.principal_type === 'user' && entry.principal.user_id === userId
  );
  if (direct) {
    return {
      capabilities: normalizeCapabilityPolicyCapabilities(policy.policy_kind, direct.capabilities),
      fs_access: direct.fs_access,
      source: 'direct_user',
      group_ids: [],
      is_primary_owner: false,
    };
  }

  const activeGroups = new Set(input.active_group_ids ?? []);
  const groupEntries = policy.entries.filter(
    (entry) =>
      entry.principal.principal_type === 'group' && activeGroups.has(entry.principal.group_id)
  );
  if (groupEntries.length > 0) {
    const capabilities = new Set<CapabilityPolicyCapability>();
    let fsAccess: CapabilityPolicyFsAccess = 'none';
    const groupIds: GroupID[] = [];
    for (const entry of groupEntries) {
      for (const capability of entry.capabilities) capabilities.add(capability);
      if (FS_ACCESS_RANK[entry.fs_access] > FS_ACCESS_RANK[fsAccess]) {
        fsAccess = entry.fs_access;
      }
      if (entry.principal.principal_type === 'group') groupIds.push(entry.principal.group_id);
    }
    // Group grants are additive by dimension. A work-capable role from one
    // group plus filesystem access from another therefore derives Terminal in
    // exactly the same way as a single stored role/filesystem pair.
    if (
      policy.policy_kind === 'branch_access' &&
      fsAccess !== 'none' &&
      capabilities.has('sessions.create') &&
      capabilities.has('sessions.prompt_own')
    ) {
      capabilities.add('terminal.open');
    }
    return {
      capabilities: normalizeCapabilityPolicyCapabilities(policy.policy_kind, [...capabilities]),
      fs_access: fsAccess,
      source: 'group',
      group_ids: groupIds,
      is_primary_owner: false,
    };
  }

  return {
    capabilities: normalizeCapabilityPolicyCapabilities(
      policy.policy_kind,
      policy.others.capabilities
    ),
    fs_access: policy.others.fs_access,
    source: 'others',
    group_ids: [],
    is_primary_owner: false,
  };
}
