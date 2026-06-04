/**
 * Unified form state for the Branch / Assistant modal.
 *
 * Lifts state for the General, Assistant, and Permissions tabs into a single
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
  AssistantConfig,
  Branch,
  BranchGroupGrantWithGroup,
  BranchPermissionLevel,
  Group,
  User,
} from '@agor-live/client';
import { getAssistantConfig, hasMinimumRole, isAssistant, ROLES } from '@agor-live/client';
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

export interface AssistantFormState {
  displayName: string;
  emoji: string;
  description: string;
}

export interface PermissionsFormState {
  selectedOwnerIds: string[];
  othersCan: BranchPermissionLevel;
  othersFsAccess: FsAccessLevel;
  allowSessionSharing: boolean;
  groupGrants: Array<{ group_id: string; can: BranchPermissionLevel; fs_access?: FsAccessLevel }>;
}

export interface BranchModalFormApi {
  // General slice
  general: GeneralFormState;
  setGeneral: <K extends keyof GeneralFormState>(key: K, value: GeneralFormState[K]) => void;
  generalChanged: boolean;

  // Assistant slice
  assistant: AssistantFormState;
  setAssistant: <K extends keyof AssistantFormState>(key: K, value: AssistantFormState[K]) => void;
  assistantChanged: boolean;

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
  rbacEnabled: boolean;
  loadingOwners: boolean;
  /** Non-fatal owners-load failure (network / server error, not 404). */
  ownersLoadError: Error | null;

  // Permissions used for gating UI
  canEditGeneral: boolean;
  canEditPermissions: boolean;

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

const buildAssistantDefaults = (branch: Branch | null): AssistantFormState => {
  const config = branch ? getAssistantConfig(branch) : null;
  return {
    displayName: config?.displayName || '',
    emoji: config?.emoji || '',
    description: branch?.notes || '',
  };
};

const buildPermissionsDefaults = (branch: Branch | null, owners: User[]): PermissionsFormState => ({
  selectedOwnerIds: owners.map((o) => o.user_id),
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
  const [ownersLoadError, setOwnersLoadError] = useState<Error | null>(null);

  const [saving, setSaving] = useState(false);

  // Form slices
  const [general, setGeneralState] = useState<GeneralFormState>(() => buildGeneralDefaults(branch));
  const [assistant, setAssistantState] = useState<AssistantFormState>(() =>
    buildAssistantDefaults(branch)
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
  const assistantTouchedRef = useRef<boolean>(false);
  const permissionsTouchedRef = useRef<boolean>(false);

  const setGeneral = useCallback<BranchModalFormApi['setGeneral']>((key, value) => {
    generalTouchedRef.current = true;
    setGeneralState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setAssistant = useCallback<BranchModalFormApi['setAssistant']>((key, value) => {
    assistantTouchedRef.current = true;
    setAssistantState((prev) => ({ ...prev, [key]: value }));
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
      assistantTouchedRef.current = false;
      permissionsTouchedRef.current = false;
      return;
    }
    const isNewBranch = initBranchIdRef.current !== branch.branch_id;
    if (isNewBranch) {
      initBranchIdRef.current = branch.branch_id;
      generalTouchedRef.current = false;
      assistantTouchedRef.current = false;
      permissionsTouchedRef.current = false;
      setGeneralState(buildGeneralDefaults(branch));
      setAssistantState(buildAssistantDefaults(branch));
      setPermissionsState(buildPermissionsDefaults(branch, []));
      setOwners([]);
      setLoadingOwners(true);
      return;
    }
    // Same branch, refreshed prop. Resync any slice the user hasn't touched.
    if (!generalTouchedRef.current) {
      setGeneralState(buildGeneralDefaults(branch));
    }
    if (!assistantTouchedRef.current) {
      setAssistantState(buildAssistantDefaults(branch));
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

  // Load owners + all users for the permissions tab
  useEffect(() => {
    if (!open || !client || !branch) return;
    const branchId = branch.branch_id;
    let cancelled = false;

    const load = async () => {
      try {
        setLoadingOwners(true);
        setOwnersLoadError(null);
        const ownersResponse = await client
          .service('branches/:id/owners')
          .find({ route: { id: branchId } });
        if (cancelled) return;
        const ownersData = ownersResponse as User[];
        setOwners(ownersData);
        // Only seed selectedOwnerIds if the user hasn't touched the permissions
        // slice yet — preserves their in-flight edits across data refreshes.
        if (!permissionsTouchedRef.current) {
          setPermissionsState((prev) => ({
            ...prev,
            selectedOwnerIds: ownersData.map((o) => o.user_id),
          }));
        }

        const [users, groups, grantsResponse] = await Promise.all([
          client.service('users').findAll({}),
          client.service('groups').findAll({ query: { archived: false } }),
          client.service('branches/:id/group-grants').find({ route: { id: branchId } }),
        ]);
        if (cancelled) return;
        setAllUsers(users);
        setAllGroups(groups as Group[]);
        const grants = (grantsResponse as BranchGroupGrantWithGroup[]).map((grant) => ({
          group_id: grant.group_id,
          can: grant.can,
          fs_access: grant.fs_access as FsAccessLevel | undefined,
        }));
        if (!permissionsTouchedRef.current) {
          setPermissionsState((prev) => ({ ...prev, groupGrants: grants }));
        }
        setRbacEnabled(true);
        // biome-ignore lint/suspicious/noExplicitAny: error from feathers client is loosely typed
      } catch (error: any) {
        if (cancelled) return;
        if (error?.code === 404 || error?.message?.includes('not found')) {
          setRbacEnabled(false);
          setOwners([]);
        } else {
          // Surface the failure to the modal. Without this, a non-admin owner
          // sees a silently-locked-down modal (owners=[] makes isOwner false →
          // canEdit* false) with no way to know what happened.
          const err = error instanceof Error ? error : new Error(String(error));
          console.error('Failed to load branch owners:', err);
          setOwnersLoadError(err);
        }
      } finally {
        if (!cancelled) setLoadingOwners(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [open, client, branch]);

  // Change detection per slice
  const isAssistantBranch = branch ? isAssistant(branch) : false;
  const generalChanged = useMemo(() => {
    if (!branch) return false;
    const notesChanged = !isAssistantBranch && general.notes !== (branch.notes || '');
    return (
      general.boardId !== (branch.board_id || undefined) ||
      general.issueUrl !== (branch.issue_url || '') ||
      general.prUrl !== (branch.pull_request_url || '') ||
      notesChanged ||
      sortedJson(general.mcpServerIds) !== sortedJson(branch.mcp_server_ids || [])
    );
  }, [branch, general, isAssistantBranch]);

  const assistantChanged = useMemo(() => {
    if (!branch || !isAssistantBranch) return false;
    const config = getAssistantConfig(branch);
    if (!config) return false;
    return (
      assistant.displayName.trim() !== config.displayName ||
      assistant.emoji !== (config.emoji || '') ||
      assistant.description.trim() !== (branch.notes || '')
    );
  }, [branch, assistant, isAssistantBranch]);

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
      permissions.allowSessionSharing !== Boolean(branch.dangerously_allow_session_sharing)
    );
  }, [branch, rbacEnabled, permissions]);

  // Conservative dirty bit: any edit in the permissions tab may require
  // re-saving branch group grants. The save path diffs against the server
  // before writing, so this remains safe for owner-only/field-only edits.
  const groupGrantsChanged = Boolean(branch && rbacEnabled && permissionsTouchedRef.current);

  const permissionsChanged = ownersChanged || permissionFieldsChanged || groupGrantsChanged;

  const hasChanges = generalChanged || assistantChanged || permissionsChanged;

  // Permission gating
  const currentUserId = currentUser?.user_id;
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const isOwner = owners.some((o) => o.user_id === currentUserId);

  // While loading owners, allow admins to edit; restrict to admin/owner once loaded
  const canEditGeneral = loadingOwners ? isAdmin : !rbacEnabled || isAdmin || isOwner;
  const canEditPermissions = isAdmin || (!loadingOwners && isOwner);

  const reset = useCallback(() => {
    setGeneralState(buildGeneralDefaults(branch));
    setAssistantState(buildAssistantDefaults(branch));
    setPermissionsState(buildPermissionsDefaults(branch, owners));
    generalTouchedRef.current = false;
    assistantTouchedRef.current = false;
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
        if (!isAssistantBranch) {
          updates.notes = general.notes.trim() === '' ? null : general.notes;
        }
        if (sortedJson(general.mcpServerIds) !== sortedJson(branch.mcp_server_ids || [])) {
          updates.mcp_server_ids = general.mcpServerIds;
        }
      }

      if (assistantChanged && isAssistantBranch && canEditGeneral) {
        const config = getAssistantConfig(branch);
        if (config) {
          const updatedConfig: AssistantConfig = {
            ...config,
            kind: 'assistant',
            displayName: assistant.displayName.trim(),
            emoji: assistant.emoji || undefined,
          };
          updates.custom_context = { assistant: updatedConfig };
          updates.notes = assistant.description.trim() || null;
        }
      }

      if (rbacEnabled && permissionFieldsChanged && canEditPermissions) {
        updates.others_can = permissions.othersCan;
        updates.others_fs_access = permissions.othersFsAccess;
        updates.dangerously_allow_session_sharing = permissions.allowSessionSharing;
      }

      if (Object.keys(updates).length > 0) {
        // Call the service directly — going through a parent helper would let
        // it swallow the error and we'd report a false success. Runs BEFORE
        // the owner-remove pass so the current user (who may be losing
        // ownership) is still authorized to PATCH at this point.
        await client.service('branches').patch(branch.branch_id, updates as Partial<Branch>);
      }

      // 3. Upsert/remove branch group grants.
      if (rbacEnabled && canEditPermissions) {
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

      // 5. Assistant emoji → board icon side effect. Cosmetic only — log on
      // failure, don't fail the save.
      if (assistantChanged && isAssistantBranch && canEditGeneral && branch.board_id) {
        const config = getAssistantConfig(branch);
        const emojiChanged = config && assistant.emoji !== (config.emoji || '');
        if (emojiChanged) {
          try {
            await client.service('boards').patch(branch.board_id, {
              icon: assistant.emoji || '🤖',
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
      assistantTouchedRef.current = false;
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
    owners,
    permissions,
    generalChanged,
    canEditGeneral,
    general,
    isAssistantBranch,
    assistantChanged,
    assistant,
  ]);

  return {
    general,
    setGeneral,
    generalChanged,
    assistant,
    setAssistant,
    assistantChanged,
    permissions,
    setPermissions,
    permissionsChanged,
    owners,
    allUsers,
    allGroups,
    rbacEnabled,
    loadingOwners,
    ownersLoadError,
    canEditGeneral,
    canEditPermissions,
    hasChanges,
    saving,
    save,
    reset,
  };
}
