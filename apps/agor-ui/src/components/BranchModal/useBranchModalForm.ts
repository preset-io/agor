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
  BranchPermissionLevel,
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
  rbacEnabled: boolean;
  loadingOwners: boolean;

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
  const [rbacEnabled, setRbacEnabled] = useState<boolean>(true);
  const [loadingOwners, setLoadingOwners] = useState<boolean>(true);

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

        const users = await client.service('users').findAll({});
        if (cancelled) return;
        setAllUsers(users);
        setRbacEnabled(true);
        // biome-ignore lint/suspicious/noExplicitAny: error from feathers client is loosely typed
      } catch (error: any) {
        if (cancelled) return;
        if (error?.code === 404 || error?.message?.includes('not found')) {
          setRbacEnabled(false);
          setOwners([]);
        } else {
          console.error('Failed to load branch owners:', error);
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

  const permissionsChanged = useMemo(() => {
    if (!branch || !rbacEnabled) return false;
    const currentOwnerIds = owners.map((o) => o.user_id as string);
    const ownersChanged =
      permissions.selectedOwnerIds.length !== currentOwnerIds.length ||
      permissions.selectedOwnerIds.some((id) => !currentOwnerIds.includes(id));
    const fieldsChanged =
      permissions.othersCan !== (branch.others_can || 'session') ||
      permissions.othersFsAccess !== (branch.others_fs_access || 'read') ||
      permissions.allowSessionSharing !== Boolean(branch.dangerously_allow_session_sharing);
    return ownersChanged || fieldsChanged;
  }, [branch, rbacEnabled, owners, permissions]);

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
      // 1. Permissions: owner add/remove diffs (skip if user can't edit perms)
      if (rbacEnabled && permissionsChanged && canEditPermissions) {
        const currentOwnerIds = owners.map((o) => o.user_id as string);
        const added = permissions.selectedOwnerIds.filter((id) => !currentOwnerIds.includes(id));
        const removed = currentOwnerIds.filter((id) => !permissions.selectedOwnerIds.includes(id));

        // Defensive guard — never let the form end up with zero owners. The
        // UI already prevents this but a paranoid check here protects against
        // race conditions where owners reloaded mid-edit.
        if (permissions.selectedOwnerIds.length === 0) {
          throw new Error('At least one owner is required');
        }

        for (const userId of added) {
          await client
            .service('branches/:id/owners')
            .create({ user_id: userId }, { route: { id: branch.branch_id } });
        }
        for (const userId of removed) {
          await client
            .service('branches/:id/owners')
            .remove(userId, { route: { id: branch.branch_id } });
        }
      }

      // 2. Build a single patch payload for the branch row
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

      if (rbacEnabled && permissionsChanged && canEditPermissions) {
        updates.others_can = permissions.othersCan;
        updates.others_fs_access = permissions.othersFsAccess;
        updates.dangerously_allow_session_sharing = permissions.allowSessionSharing;
      }

      if (Object.keys(updates).length > 0) {
        // Call the service directly — going through a parent helper would let
        // it swallow the error and we'd report a false success.
        await client.service('branches').patch(branch.branch_id, updates as Partial<Branch>);
      }

      // 3. Assistant emoji → board icon side effect. Cosmetic only — log on
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
    rbacEnabled,
    loadingOwners,
    canEditGeneral,
    canEditPermissions,
    hasChanges,
    saving,
    save,
    reset,
  };
}
