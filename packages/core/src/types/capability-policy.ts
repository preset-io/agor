import type { BoardID, GroupID, UserID, UUID } from './id';

/**
 * Proposed capability-policy contract used by the UI prototype.
 *
 * This is deliberately persistence-neutral: it does not mean the capability
 * model is enforced or stored yet. Keeping the proposal in core gives Board
 * and Branch forms one canonical vocabulary while product/design feedback is
 * still shaping the eventual API and schema.
 */
export const CAPABILITY_POLICY_SCHEMA_VERSION = 1 as const;

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

export type CapabilityPolicyPresetId =
  | 'none'
  | 'viewer'
  | 'editor'
  | 'collaborator'
  | 'manager'
  | 'custom';

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
 * The one explicit fallback entry. In the prototype it matches only active
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
  board_access: CapabilityPolicyDraft;
  /** Live defaults inherited by aligned branches; each branch keeps its own owner. */
  branch_template: CapabilityPolicyDraft;
}

/**
 * One existing person or group allowed to prompt sessions owned by one user.
 *
 * This is intentionally separate from the reusable branch policy. It is a
 * personal, owner-authored exception that can cross an execution-home
 * boundary; it must never be inherited from a board or edited by a branch
 * manager on the session owner's behalf.
 */
export interface BranchSessionSharingGrantDraft {
  grant_id: UUID;
  principal: CapabilityPolicyPrincipalRef;
}

export interface BranchSessionSharingOwnerRuleDraft {
  session_owner_user_id: UserID;
  enabled: boolean;
  grantees: BranchSessionSharingGrantDraft[];
}

export interface BranchSessionSharingDraft {
  owner_rules: BranchSessionSharingOwnerRuleDraft[];
}

/**
 * Tenant-level product gate for personal session sharing.
 *
 * This deliberately lives outside a board or branch policy: a workspace
 * administrator can revoke the feature everywhere, while every personal rule
 * remains authored by its session owner. The prototype consumes this as a
 * read model only; it does not imply that persistence or enforcement exists.
 */
export interface CapabilityPolicyWorkspacePreferencesDraft {
  personal_session_sharing_enabled: boolean;
}

export interface BranchSessionSharingValidationIssue {
  code: 'duplicate_owner_rule' | 'disabled_rule_has_grantees' | 'duplicate_grantee' | 'self_grant';
  message: string;
  owner_user_id: UserID;
  grant_id?: UUID;
}

export interface BranchCapabilityPolicyDraft {
  primary_owner_user_id: UserID;
  binding_mode: CapabilityPolicyBindingMode;
  inherited_from_board_id?: BoardID;
  inherited_policy?: CapabilityPolicyDraft;
  override_policy?: CapabilityPolicyDraft;
  /** Per-session-owner dangerous sharing exceptions; never board-inherited. */
  session_sharing: BranchSessionSharingDraft;
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
    | 'terminal_requires_filesystem_access';
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
  const values: Array<Pick<CapabilityPolicyEntryDraft, 'entry_id' | 'capabilities' | 'fs_access'>> =
    [...policy.entries];

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
    capabilities: policy.others.capabilities,
    fs_access: policy.others.fs_access,
  });

  for (const value of values) {
    const selected = new Set(value.capabilities);
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

export function validateBranchSessionSharingDraft(
  sharing: BranchSessionSharingDraft
): BranchSessionSharingValidationIssue[] {
  const issues: BranchSessionSharingValidationIssue[] = [];
  const seenOwners = new Set<UserID>();

  for (const rule of sharing.owner_rules) {
    if (seenOwners.has(rule.session_owner_user_id)) {
      issues.push({
        code: 'duplicate_owner_rule',
        owner_user_id: rule.session_owner_user_id,
        message: 'Each session owner can have only one personal sharing rule per branch.',
      });
    }
    seenOwners.add(rule.session_owner_user_id);

    if (!rule.enabled && rule.grantees.length > 0) {
      issues.push({
        code: 'disabled_rule_has_grantees',
        owner_user_id: rule.session_owner_user_id,
        message: 'Turning personal session sharing off must remove its grantee entries.',
      });
    }

    const seenGrantees = new Set<string>();
    for (const grant of rule.grantees) {
      const granteeKey = capabilityPolicyPrincipalKey(grant.principal);
      if (seenGrantees.has(granteeKey)) {
        issues.push({
          code: 'duplicate_grantee',
          owner_user_id: rule.session_owner_user_id,
          grant_id: grant.grant_id,
          message: 'Each person or group can appear only once in an owner’s sharing rule.',
        });
      }
      seenGrantees.add(granteeKey);

      if (
        grant.principal.principal_type === 'user' &&
        grant.principal.user_id === rule.session_owner_user_id
      ) {
        issues.push({
          code: 'self_grant',
          owner_user_id: rule.session_owner_user_id,
          grant_id: grant.grant_id,
          message: 'A session owner does not need to share their sessions with themselves.',
        });
      }
    }
  }

  return issues;
}
