/**
 * Unified form state for the Branch / Teammate modal.
 *
 * Lifts state for the General, Teammate, and Permissions tabs into a single
 * place so the modal can offer one consolidated Save action. Each tab consumes
 * the slice it needs as controlled props.
 *
 * Tabs deliberately NOT covered by this form:
 *   - Sessions, Files, Schedules — read-only / their own CRUD
 *   - Environment — start/stop/nuke + YAML editors with independent actions
 *
 * `save()` calls `client.service('branches').patch()` directly so failures
 * bubble back to the caller. Going through the parent's `onUpdateBranch`
 * helper would swallow errors (the App-level helper toast-and-discards) and
 * the modal would close on a silent failure.
 *
 * See PR description for the rationale.
 */

import type {
  AgorClient,
  Branch,
  BranchGroupGrantWithGroup,
  BranchPermissionLevel,
  EffectiveBranchAccess,
  Group,
  TeammateConfig,
  User,
} from '@agor-live/client';
import { getTeammateConfig, hasMinimumRole, isTeammate, ROLES } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Patchable subset of `Branch` writable from the modal form. */
export type BranchUpdate = Omit<
  Partial<Branch>,
  'issue_url' | 'pull_request_url' | 'notes' | 'board_id'
> & {
  board_id?: string | null | undefined;
  issue_url?: string | null | undefined;
  pull_request_url?: string | null | undefined;
  notes?: string | null | undefined;
};

/** Derive directly from Branch so the union stays in sync with core. */
export type FsAccessLevel = NonNullable<Branch['others_fs_access']>;

export interface GeneralFormState {
  boardId: string | undefined;
  issueUrl: string;
  prUrl: string;
  notes: string;
  mcpServerIds: string[];
}

export interface TeammateFormState {
  displayName: string;
  emoji: string;
  description: string;
}

export interface PermissionsFormState {
  permissionSource: NonNullable<Branch['permission_source']>;
  selectedOwnerIds: string[];
  othersCan: BranchPermissionLevel;
  othersFsAccess: FsAccessLevel;
  allowSessionSharing: boolean;
  groupGrants: Array<{ group_id: string; can: BranchPermissionLevel; fs_access?: FsAccessLevel }>;
}

export type GroupGrantsStatus = 'loading' | 'loaded' | 'unavailable';

export interface BranchModalFormApi {
  // General slice
  general: GeneralFormState;
  setGeneral: <K extends keyof GeneralFormState>(key: K, value: GeneralFormState[K]) => void;
  generalChanged: boolean;

  // Teammate slice
  teammate: TeammateFormState;
  setTeammate: <K extends keyof TeammateFormState>(key: K, value: TeammateFormState[K]) => void;
  teammateChanged: boolean;

  // Permissions slice
  permissions: PermissionsFormState;
  setPermissions: <K extends keyof PermissionsFormState>(
    key: K,
    value: PermissionsFormState[K]
  ) => void;
  permissionsChanged: boolean;

  // Owners metadata (loaded async)
  owners: User[];
  allUsers: User[];
  allGroups: Group[];
  groupGrantsStatus: GroupGrantsStatus;
  groupGrantsError: Error | null;
  rbacEnabled: boolean;
  loadingOwners: boolean;
  /**
   * Whether the modal should render the Permissions tab.
   *
   * Admins keep the tab while permissions metadata is loading/partial so a
   * secondary endpoint failure (for example group grants) cannot hide branch
   * management from them. Non-admins keep it during owner loading, then only
   * retain it if they are confirmed branch owners.
   */
  canViewPermissions: boolean;
  /** Non-fatal owners-load failure (network / server error, not 404). */
  ownersLoadError: Error | null;

  // Permissions used for gating UI
  canEditGeneral: boolean;
  canEditPermissions: boolean;
  canControlEnvironment: boolean;

  // Aggregate state
  hasChanges: boolean;
  saving: boolean;

  // Actions
  save: () => Promise<{ ok: true } | { ok: false; error: Error }>;
  reset: () => void;
}

interface UseBranchModalFormOptions {
  branch: Branch | null;
  client: AgorClient | null;
  currentUser?: User | null;
  open: boolean;
}

const buildGeneralDefaults = (branch: Branch | null): GeneralFormState => ({
  boardId: branch?.board_id || undefined,
  issueUrl: branch?.issue_url || '',
  prUrl: branch?.pull_request_url || '',
  notes: branch?.notes || '',
  mcpServerIds: branch?.mcp_server_ids || [],
});

const buildTeammateDefaults = (branch: Branch | null): TeammateFormState => {
  const config = branch ? getTeammateConfig(branch) : null;
  return {
    displayName: config?.displayName || '',
    emoji: config?.emoji || '',
    description: branch?.notes || '',
  };
};

const buildPermissionsDefaults = (branch: Branch | null, owners: User[]): PermissionsFormState => ({
  permissionSource: branch?.permission_source || 'override',
  selectedOwnerIds:
    owners.length > 0
      ? owners.map((o) => o.user_id)
      : branch?.created_by
        ? [branch.created_by]
        : [],
  othersCan: branch?.others_can || 'session',
  othersFsAccess: branch?.others_fs_access || 'read',
  allowSessionSharing: Boolean(branch?.dangerously_allow_session_sharing),
  groupGrants: [],
});

const sortedJson = (xs: string[]): string => JSON.stringify([...xs].sort());

export function useBranchModalForm({
  branch,
  client,
  currentUser,
  open,
}: UseBranchModalFormOptions): BranchModalFormApi {
  // Async-loaded owners data
  const [owners, setOwners] = useState<User[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [rbacEnabled, setRbacEnabled] = useState<boolean>(true);
  const [loadingOwners, setLoadingOwners] = useState<boolean>(true);
  const [groupGrantsStatus, setGroupGrantsStatus] = useState<GroupGrantsStatus>('loading');
  const [groupGrantsError, setGroupGrantsError] = useState<Error | null>(null);
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveBranchAccess | null>(null);
  const [ownersLoadError, setOwnersLoadError] = useState<Error | null>(null);

  const [saving, setSaving] = useState(false);

  // Form slices
  const [general, setGeneralState] = useState<GeneralFormState>(() => buildGeneralDefaults(branch));
  const [teammate, setTeammateState] = useState<TeammateFormState>(() =>
    buildTeammateDefaults(branch)
  );
  const [permissions, setPermissionsState] = useState<PermissionsFormState>(() =>
    buildPermissionsDefaults(branch, [])
  );

  // Which branch did we initialize for? Used to detect branch swaps while the
  // modal is open (rare but possible via deep links).
  const initBranchIdRef = useRef<string | null>(null);
  // Per-slice "user has edited this slice" gates. Untouched slices are kept
  // in sync with the latest server state via WebSocket-driven prop changes;
  // touched slices are left alone until Save or Reset.
  const generalTouchedRef = useRef<boolean>(false);
  const teammateTouchedRef = useRef<boolean>(false);
  const permissionsTouchedRef = useRef<boolean>(false);

  const setGeneral = useCallback<BranchModalFormApi['setGeneral']>((key, value) => {
    generalTouchedRef.current = true;
    setGeneralState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setTeammate = useCallback<BranchModalFormApi['setTeammate']>((key, value) => {
    teammateTouchedRef.current = true;
    setTeammateState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setPermissions = useCallback<BranchModalFormApi['setPermissions']>((key, value) => {
    permissionsTouchedRef.current = true;
    setPermissionsState((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Branch lifecycle. Handles three scenarios:
  //   1. Modal closed / no branch → clear init refs so the next open re-seeds.
  //   2. Modal opens for a different branch → full reset, all touched=false.
  //   3. Same branch but new prop reference (WebSocket update) → re-sync only
  //      untouched slices so external edits propagate without trampling
  //      in-flight user edits.
  useEffect(() => {
    if (!open || !branch) {
      initBranchIdRef.current = null;
      generalTouchedRef.current = false;
      teammateTouchedRef.current = false;
      permissionsTouchedRef.current = false;
      return;
    }
    const isNewBranch = initBranchIdRef.current !== branch.branch_id;
    if (isNewBranch) {
      initBranchIdRef.current = branch.branch_id;
      generalTouchedRef.current = false;
      teammateTouchedRef.current = false;
      permissionsTouchedRef.current = false;
      setGeneralState(buildGeneralDefaults(branch));
      setTeammateState(buildTeammateDefaults(branch));
      setPermissionsState(buildPermissionsDefaults(branch, []));
      setOwners([]);
      setAllUsers([]);
      setAllGroups([]);
      setRbacEnabled(true);
      setGroupGrantsStatus('loading');
      setGroupGrantsError(null);
      setLoadingOwners(true);
      return;
    }
    // Same branch, refreshed prop. Resync any slice the user hasn't touched.
    if (!generalTouchedRef.current) {
      setGeneralState(buildGeneralDefaults(branch));
    }
    if (!teammateTouchedRef.current) {
      setTeammateState(buildTeammateDefaults(branch));
    }
    // Permissions slice — only non-owner fields here; selectedOwnerIds is
    // resynced from the owners-load effect below using the same touched gate.
    if (!permissionsTouchedRef.current) {
      setPermissionsState((prev) => ({
        ...prev,
        othersCan: branch.others_can || 'session',
        othersFsAccess: branch.others_fs_access || 'read',
        allowSessionSharing: Boolean(branch.dangerously_allow_session_sharing),
      }));
    }
  }, [open, branch]);

  // Load owners + all users/groups for the permissions tab.
  //
  // RBAC feature detection must be based only on the owners endpoint. Group
  // grants are additive metadata; if that endpoint is missing/failing (for
  // example during a rolling deploy or against an older daemon) we should keep
  // the tab visible for admins/owners rather than treating the whole RBAC
  // surface as disabled.
  useEffect(() => {
    if (!open || !client || !branch) return;
    const branchId = branch.branch_id;
    let cancelled = false;

    const load = async () => {
      try {
        setLoadingOwners(true);
        setOwnersLoadError(null);
        setGroupGrantsStatus('loading');
        setGroupGrantsError(null);
        setEffectiveAccess(null);
        const effectiveAccessPromise = client
          .service('branches/:id/effective-access')
          .find({ route: { id: branchId } })
          .catch((error: unknown) => {
            console.warn('Failed to load effective branch access:', error);
            return null;
          });
        const ownersResponse = await client
          .service('branches/:id/owners')
          .find({ route: { id: branchId } });
        if (cancelled) return;
        const resolvedEffectiveAccess = await effectiveAccessPromise;
        if (cancelled) return;
        setEffectiveAccess(resolvedEffectiveAccess as EffectiveBranchAccess | null);
        const ownersData = ownersResponse as User[];
        setOwners(ownersData);
        setRbacEnabled(true);
        // Only seed selectedOwnerIds if the user hasn't touched the permissions
        // slice yet — preserves their in-flight edits across data refreshes.
        if (!permissionsTouchedRef.current) {
          const ownerIds =
            ownersData.length > 0
              ? ownersData.map((o) => o.user_id)
              : branch.created_by
                ? [branch.created_by]
                : [];
          setPermissionsState((prev) => ({
            ...prev,
            selectedOwnerIds: ownerIds,
          }));
        }

        try {
          const users = await client.service('users').findAll({});
          if (!cancelled) setAllUsers(users);
        } catch (error) {
          if (!cancelled) {
            console.warn('Failed to load users for branch permissions:', error);
          }
        }

        // Owners/users gate owner and branch-level editability. Group grants
        // are optional auxiliary metadata with their own status; keep loading
        // them independently so a slow/missing group-grants endpoint does not
        // hold owner/branch-level controls disabled.
        if (!cancelled) {
          setLoadingOwners(false);
        }

        try {
          const [groups, grantsResponse] = await Promise.all([
            client.service('groups').findAll({ query: { archived: false } }),
            client.service('branches/:id/group-grants').find({ route: { id: branchId } }),
          ]);
          if (cancelled) return;
          setAllGroups(groups as Group[]);
          const grants = (grantsResponse as BranchGroupGrantWithGroup[]).map((grant) => ({
            group_id: grant.group_id,
            can: grant.can,
            fs_access: grant.fs_access as FsAccessLevel | undefined,
          }));
          setGroupGrantsStatus('loaded');
          setGroupGrantsError(null);
          if (!permissionsTouchedRef.current) {
            setPermissionsState((prev) => ({ ...prev, groupGrants: grants }));
          }
        } catch (error) {
          if (!cancelled) {
            setAllGroups([]);
            setGroupGrantsStatus('unavailable');
            setGroupGrantsError(error instanceof Error ? error : new Error(String(error)));
            console.warn('Failed to load branch group permissions:', error);
          }
        }
        // biome-ignore lint/suspicious/noExplicitAny: error from feathers client is loosely typed
      } catch (error: any) {
        if (cancelled) return;
        if (error?.code === 404 || error?.message?.includes('not found')) {
          setRbacEnabled(false);
          setOwners([]);
          setAllUsers([]);
          setAllGroups([]);
          setGroupGrantsStatus('unavailable');
          setGroupGrantsError(error instanceof Error ? error : new Error(String(error)));
        } else {
          // Surface the failure to the modal. Without this, a non-admin owner
          // sees a silently-locked-down modal (owners=[] makes isOwner false →
          // canEdit* false) with no way to know what happened.
          const err = error instanceof Error ? error : new Error(String(error));
          console.error('Failed to load branch owners:', err);
          setOwnersLoadError(err);
          setAllGroups([]);
          setGroupGrantsStatus('unavailable');
          setGroupGrantsError(err);
        }
      }
      if (!cancelled) setLoadingOwners(false);
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [open, client, branch]);

  // Change detection per slice
  const isTeammateBranch = branch ? isTeammate(branch) : false;
  const generalChanged = useMemo(() => {
    if (!branch) return false;
    const notesChanged = !isTeammateBranch && general.notes !== (branch.notes || '');
    return (
      general.boardId !== (branch.board_id || undefined) ||
      general.issueUrl !== (branch.issue_url || '') ||
      general.prUrl !== (branch.pull_request_url || '') ||
      notesChanged ||
      sortedJson(general.mcpServerIds) !== sortedJson(branch.mcp_server_ids || [])
    );
  }, [branch, general, isTeammateBranch]);

  const teammateChanged = useMemo(() => {
    if (!branch || !isTeammateBranch) return false;
    const config = getTeammateConfig(branch);
    if (!config) return false;
    return (
      teammate.displayName.trim() !== config.displayName ||
      teammate.emoji !== (config.emoji || '') ||
      teammate.description.trim() !== (branch.notes || '')
    );
  }, [branch, teammate, isTeammateBranch]);

  // Owner add/remove diffs vs. permission-field edits are tracked separately:
  // owner changes route to the nested owners service while field changes go
  // into the branch PATCH. They commit at different points in the save flow
  // (owner-removes happen LAST so the caller doesn't lose authorization
  // mid-save), so we want to know which kind of change we have.
  const ownersChanged = useMemo(() => {
    if (!branch || !rbacEnabled) return false;
    const currentOwnerIds = owners.map((o) => o.user_id as string);
    return (
      permissions.selectedOwnerIds.length !== currentOwnerIds.length ||
      permissions.selectedOwnerIds.some((id) => !currentOwnerIds.includes(id))
    );
  }, [branch, rbacEnabled, owners, permissions.selectedOwnerIds]);

  const permissionFieldsChanged = useMemo(() => {
    if (!branch || !rbacEnabled) return false;
    return (
      permissions.othersCan !== (branch.others_can || 'session') ||
      permissions.othersFsAccess !== (branch.others_fs_access || 'read') ||
      permissions.allowSessionSharing !== Boolean(branch.dangerously_allow_session_sharing) ||
      permissions.permissionSource !== (branch.permission_source || 'override')
    );
  }, [branch, rbacEnabled, permissions]);

  // Conservative dirty bit: any edit in the permissions tab may require
  // re-saving branch group grants. The save path diffs against the server
  // before writing, so this remains safe for owner-only/field-only edits.
  const groupGrantsChanged = Boolean(
    branch && rbacEnabled && groupGrantsStatus === 'loaded' && permissionsTouchedRef.current
  );

  const permissionsChanged = ownersChanged || permissionFieldsChanged || groupGrantsChanged;

  const hasChanges = generalChanged || teammateChanged || permissionsChanged;

  // Permission gating
  const currentUserId = currentUser?.user_id;
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const isSuperAdmin = hasMinimumRole(currentUser?.role, ROLES.SUPERADMIN);
  const isOwner = owners.some((o) => o.user_id === currentUserId);
  const isCreator = branch?.created_by === currentUserId;
  const canControlEnvironment =
    isAdmin ||
    effectiveAccess?.can === 'all' ||
    isOwner ||
    branch?.others_can === 'all' ||
    (!rbacEnabled && isCreator);
  const canViewPermissions = rbacEnabled && (isAdmin || loadingOwners || isOwner);

  // Backend branch mutations are authorized by branch ownership or superadmin
  // branch-RBAC bypass. Plain admins can view the tab as a diagnostic/admin
  // affordance, but enabling controls for non-owner admins would lead to save
  // failures for owner/permission-field mutations.
  const canEditGeneral = loadingOwners ? isSuperAdmin : !rbacEnabled || isSuperAdmin || isOwner;
  const canEditPermissions = isSuperAdmin || (!loadingOwners && isOwner);

  const reset = useCallback(() => {
    setGeneralState(buildGeneralDefaults(branch));
    setTeammateState(buildTeammateDefaults(branch));
    setPermissionsState(buildPermissionsDefaults(branch, owners));
    generalTouchedRef.current = false;
    teammateTouchedRef.current = false;
    permissionsTouchedRef.current = false;
  }, [branch, owners]);

  const save = useCallback(async (): Promise<{ ok: true } | { ok: false; error: Error }> => {
    if (!branch || !client) {
      return { ok: false, error: new Error('Modal not ready') };
    }

    setSaving(true);
    try {
      const currentOwnerIds = owners.map((o) => o.user_id as string);
      const ownersToAdd = permissions.selectedOwnerIds.filter(
        (id) => !currentOwnerIds.includes(id)
      );
      const ownersToRemove = currentOwnerIds.filter(
        (id) => !permissions.selectedOwnerIds.includes(id)
      );

      // Pre-flight defensive guard — never let the form end up with zero
      // owners. The UI already prevents this but a paranoid check here
      // protects against owners reloaded mid-edit.
      if (rbacEnabled && ownersChanged && permissions.selectedOwnerIds.length === 0) {
        throw new Error('At least one owner is required');
      }
      if (
        rbacEnabled &&
        permissions.permissionSource === 'override' &&
        permissions.othersCan === 'none' &&
        permissions.selectedOwnerIds.length !== 1
      ) {
        throw new Error('Private branches must have exactly one private user');
      }

      // 1. Add new owners FIRST so a transfer like "remove me, add Bob"
      // doesn't briefly leave an empty owner set, and so Bob can pick up
      // ownership before we apply other changes.
      if (rbacEnabled && ownersChanged && canEditPermissions) {
        for (const userId of ownersToAdd) {
          await client
            .service('branches/:id/owners')
            .create({ user_id: userId }, { route: { id: branch.branch_id } });
        }
      }

      // 2. Build a single patch payload for the branch row. ONLY include
      // permission fields if they actually changed — including them on an
      // owner-only transfer would force a redundant authorization check
      // that the about-to-be-removed owner may not pass.
      const updates: BranchUpdate = {};

      if (generalChanged && canEditGeneral) {
        updates.board_id = general.boardId || undefined;
        updates.issue_url = general.issueUrl.trim() === '' ? null : general.issueUrl;
        updates.pull_request_url = general.prUrl.trim() === '' ? null : general.prUrl;
        if (!isTeammateBranch) {
          updates.notes = general.notes.trim() === '' ? null : general.notes;
        }
        if (sortedJson(general.mcpServerIds) !== sortedJson(branch.mcp_server_ids || [])) {
          updates.mcp_server_ids = general.mcpServerIds;
        }
      }

      if (teammateChanged && isTeammateBranch && canEditGeneral) {
        const config = getTeammateConfig(branch);
        if (config) {
          const updatedConfig: TeammateConfig = {
            ...config,
            kind: 'teammate',
            displayName: teammate.displayName.trim(),
            emoji: teammate.emoji || undefined,
          };
          updates.custom_context = { ...(branch.custom_context ?? {}), teammate: updatedConfig };
          updates.notes = teammate.description.trim() || null;
        }
      }

      if (rbacEnabled && permissionFieldsChanged && canEditPermissions) {
        updates.others_can = permissions.othersCan;
        updates.others_fs_access = permissions.othersFsAccess;
        updates.dangerously_allow_session_sharing = permissions.allowSessionSharing;
        updates.permission_source = permissions.permissionSource;
      }

      if (Object.keys(updates).length > 0) {
        // Call the service directly — going through a parent helper would let
        // it swallow the error and we'd report a false success. Runs BEFORE
        // the owner-remove pass so the current user (who may be losing
        // ownership) is still authorized to PATCH at this point.
        await client.service('branches').patch(branch.branch_id, updates as Partial<Branch>);
      }

      // 3. Upsert/remove branch group grants.
      if (rbacEnabled && canEditPermissions && groupGrantsStatus === 'loaded') {
        const currentGrants = (await client
          .service('branches/:id/group-grants')
          .find({ route: { id: branch.branch_id } })) as BranchGroupGrantWithGroup[];
        const desired = permissions.groupGrants;
        const desiredIds = new Set(desired.map((g) => g.group_id));
        for (const grant of desired) {
          const current = currentGrants.find((g) => g.group_id === grant.group_id);
          if (
            !current ||
            current.can !== grant.can ||
            (current.fs_access || undefined) !== (grant.fs_access || undefined)
          ) {
            await client
              .service('branches/:id/group-grants')
              .create(
                { group_id: grant.group_id, can: grant.can, fs_access: grant.fs_access },
                { route: { id: branch.branch_id } }
              );
          }
        }
        for (const current of currentGrants) {
          if (!desiredIds.has(current.group_id)) {
            await client
              .service('branches/:id/group-grants')
              .remove(current.group_id, { route: { id: branch.branch_id } });
          }
        }
      }

      // 4. Remove old owners LAST — after every authorization-requiring call
      // has fired. A typical owner transfer (Alice removes self + adds Bob)
      // would otherwise reach the PATCH step de-authorized.
      if (rbacEnabled && ownersChanged && canEditPermissions) {
        for (const userId of ownersToRemove) {
          await client
            .service('branches/:id/owners')
            .remove(userId, { route: { id: branch.branch_id } });
        }
      }

      // 5. Teammate emoji → board icon side effect. Cosmetic only — log on
      // failure, don't fail the save.
      if (teammateChanged && isTeammateBranch && canEditGeneral && branch.board_id) {
        const config = getTeammateConfig(branch);
        const emojiChanged = config && teammate.emoji !== (config.emoji || '');
        if (emojiChanged) {
          try {
            await client.service('boards').patch(branch.board_id, {
              icon: teammate.emoji || '🤖',
            });
          } catch (err) {
            console.error('Failed to update board icon:', err);
          }
        }
      }

      // Refresh owners cache so the next change-detection cycle reflects the
      // saved state. Doing this lazily here avoids forcing a parent re-fetch.
      if (rbacEnabled && permissionsChanged) {
        try {
          const response = await client
            .service('branches/:id/owners')
            .find({ route: { id: branch.branch_id } });
          const ownersData = response as User[];
          setOwners(ownersData);
          setPermissionsState((prev) => ({
            ...prev,
            selectedOwnerIds: ownersData.map((o) => o.user_id),
          }));
        } catch (err) {
          console.error('Failed to reload owners after save:', err);
        }
      }

      // Clear all touched flags — the form is once again clean against the
      // server state. WebSocket-driven prop updates may resync slices freely.
      generalTouchedRef.current = false;
      teammateTouchedRef.current = false;
      permissionsTouchedRef.current = false;

      return { ok: true };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { ok: false, error: err };
    } finally {
      setSaving(false);
    }
  }, [
    branch,
    client,
    rbacEnabled,
    ownersChanged,
    permissionFieldsChanged,
    permissionsChanged,
    canEditPermissions,
    groupGrantsStatus,
    owners,
    permissions,
    generalChanged,
    canEditGeneral,
    general,
    isTeammateBranch,
    teammateChanged,
    teammate,
  ]);

  return {
    general,
    setGeneral,
    generalChanged,
    teammate,
    setTeammate,
    teammateChanged,
    permissions,
    setPermissions,
    permissionsChanged,
    owners,
    allUsers,
    allGroups,
    groupGrantsStatus,
    groupGrantsError,
    rbacEnabled,
    loadingOwners,
    canViewPermissions,
    ownersLoadError,
    canEditGeneral,
    canEditPermissions,
    canControlEnvironment,
    hasChanges,
    saving,
    save,
    reset,
  };
}
