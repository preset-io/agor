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
  BranchCapabilityPolicy,
  CapabilityPolicyWorkspacePreferences,
  EffectiveBranchAccess,
  EffectiveCapabilityPolicyAccess,
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
  permissionsChanged: boolean;
  capabilityPolicy: BranchCapabilityPolicy | null;
  setCapabilityPolicy: (value: BranchCapabilityPolicy) => void;
  workspacePreferences: CapabilityPolicyWorkspacePreferences;

  allUsers: User[];
  allGroups: Group[];
  permissionsLoading: boolean;
  canViewPermissions: boolean;
  permissionsLoadError: Error | null;

  // Permissions used for gating UI
  canEditGeneral: boolean;
  canManagePolicy: boolean;
  canEditPermissions: boolean;
  canControlEnvironment: boolean;

  // Board-move validation: `board_id` is a Select of every board the caller
  // can VIEW, not just the ones they can attach a branch to, so a selection
  // can't be pre-filtered the way other fields are disabled outright. This
  // is checked reactively once a target board is actually picked.
  boardAttachChecking: boolean;
  boardAttachError: string | null;

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

const sortedJson = (xs: string[]): string => JSON.stringify([...xs].sort());

export function useBranchModalForm({
  branch,
  client,
  currentUser,
  open,
}: UseBranchModalFormOptions): BranchModalFormApi {
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState<boolean>(true);
  const [effectiveAccess, setEffectiveAccess] = useState<EffectiveBranchAccess | null>(null);
  const [capabilityPolicy, setCapabilityPolicyState] = useState<BranchCapabilityPolicy | null>(
    null
  );
  const [workspacePreferences, setWorkspacePreferences] =
    useState<CapabilityPolicyWorkspacePreferences>({ session_sharing_enabled: false });
  const [permissionsLoadError, setPermissionsLoadError] = useState<Error | null>(null);
  const [boardAttachChecking, setBoardAttachChecking] = useState(false);
  const [boardAttachError, setBoardAttachError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);

  // Form slices
  const [general, setGeneralState] = useState<GeneralFormState>(() => buildGeneralDefaults(branch));
  const [teammate, setTeammateState] = useState<TeammateFormState>(() =>
    buildTeammateDefaults(branch)
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
  const initialCapabilityPolicyRef = useRef<BranchCapabilityPolicy | null>(null);

  const setGeneral = useCallback<BranchModalFormApi['setGeneral']>((key, value) => {
    generalTouchedRef.current = true;
    setGeneralState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setTeammate = useCallback<BranchModalFormApi['setTeammate']>((key, value) => {
    teammateTouchedRef.current = true;
    setTeammateState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setCapabilityPolicy = useCallback((value: BranchCapabilityPolicy) => {
    permissionsTouchedRef.current = true;
    setCapabilityPolicyState(value);
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
      setCapabilityPolicyState(null);
      initialCapabilityPolicyRef.current = null;
      setAllUsers([]);
      setAllGroups([]);
      setPermissionsLoading(true);
      return;
    }
    // Same branch, refreshed prop. Resync any slice the user hasn't touched.
    if (!generalTouchedRef.current) {
      setGeneralState(buildGeneralDefaults(branch));
    }
    if (!teammateTouchedRef.current) {
      setTeammateState(buildTeammateDefaults(branch));
    }
  }, [open, branch]);

  const branchId = branch?.branch_id;

  // Load the normalized permission package and its principal directory.
  useEffect(() => {
    if (!open || !client || !branchId) return;
    let cancelled = false;
    const load = async () => {
      setPermissionsLoading(true);
      setPermissionsLoadError(null);
      try {
        const [policyResult, accessResult, usersResult, groupsResult, preferencesResult] =
          await Promise.allSettled([
            client.service('branches/:id/permissions').find({ route: { id: branchId } }),
            client.service('branches/:id/effective-access').find({ route: { id: branchId } }),
            client.service('users').findAll({}),
            client.service('groups').findAll({ query: { archived: false } }),
            client.service('workspace-preferences').find(),
          ]);
        if (cancelled) return;
        if (policyResult.status !== 'fulfilled') throw policyResult.reason;
        const loadedPolicy = policyResult.value;
        setCapabilityPolicyState(loadedPolicy);
        initialCapabilityPolicyRef.current = structuredClone(loadedPolicy);
        setEffectiveAccess(
          accessResult.status === 'fulfilled'
            ? (accessResult.value as unknown as EffectiveBranchAccess)
            : null
        );
        const users = usersResult.status === 'fulfilled' ? (usersResult.value as User[]) : [];
        setAllUsers(users);
        setAllGroups(groupsResult.status === 'fulfilled' ? (groupsResult.value as Group[]) : []);
        setWorkspacePreferences(
          preferencesResult.status === 'fulfilled'
            ? preferencesResult.value
            : { session_sharing_enabled: false }
        );
      } catch (error) {
        if (cancelled) return;
        const next = error instanceof Error ? error : new Error(String(error));
        setPermissionsLoadError(next);
        setCapabilityPolicyState(null);
      } finally {
        if (!cancelled) setPermissionsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, client, branchId]);

  // Validate a newly-selected target board once it's actually picked, rather
  // than trying to pre-filter the Select's options: the board list is scoped
  // to "boards I can VIEW", and knowing which of those the caller can also
  // attach a branch to would mean an effective-access call per board. The
  // daemon rejects a move to a board without `board.attach_branch` (or away
  // from the current board without `board.edit`), so this mirrors that one
  // check for the one board actually chosen.
  const targetBoardId = general.boardId;
  useEffect(() => {
    if (!open || !client) {
      setBoardAttachError(null);
      return;
    }
    const originalBoardId = branch?.board_id || undefined;
    if (!targetBoardId || targetBoardId === originalBoardId) {
      setBoardAttachError(null);
      return;
    }
    let cancelled = false;
    setBoardAttachChecking(true);
    setBoardAttachError(null);
    client
      .service('boards/:id/effective-access')
      .find({ route: { id: targetBoardId } })
      .then((access: unknown) => {
        if (cancelled) return;
        const capabilities = (access as EffectiveCapabilityPolicyAccess).capabilities;
        if (!capabilities.includes('board.attach_branch')) {
          setBoardAttachError('You need Board Editor or Manager access to move a branch here.');
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setBoardAttachError(
          error instanceof Error ? error.message : 'Could not verify access to that board.'
        );
      })
      .finally(() => {
        if (!cancelled) setBoardAttachChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, client, branch?.board_id, targetBoardId]);

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

  const permissionsChanged = Boolean(
    capabilityPolicy &&
      initialCapabilityPolicyRef.current &&
      JSON.stringify(capabilityPolicy) !== JSON.stringify(initialCapabilityPolicyRef.current)
  );

  const hasChanges = generalChanged || teammateChanged || permissionsChanged;

  // Permission gating. The legacy effective-access adapter maps Manager to all.
  const currentUserId = currentUser?.user_id;
  const isSuperAdmin = hasMinimumRole(currentUser?.role, ROLES.SUPERADMIN);
  const isPrimaryOwner = capabilityPolicy?.primary_owner_user_id === currentUserId;
  const canManagePolicy = Boolean(
    capabilityPolicy && (isSuperAdmin || effectiveAccess?.can === 'all' || isPrimaryOwner)
  );
  const canControlEnvironment = canManagePolicy;
  const canViewPermissions = Boolean(capabilityPolicy);
  const canEditGeneral = canManagePolicy;
  // Every authenticated viewer may author their own personal session-sharing
  // rule; only policy managers can change access entries or binding mode.
  const canEditPermissions = Boolean(capabilityPolicy && currentUserId);

  const reset = useCallback(() => {
    setGeneralState(buildGeneralDefaults(branch));
    setTeammateState(buildTeammateDefaults(branch));
    setCapabilityPolicyState(
      initialCapabilityPolicyRef.current
        ? structuredClone(initialCapabilityPolicyRef.current)
        : null
    );
    generalTouchedRef.current = false;
    teammateTouchedRef.current = false;
    permissionsTouchedRef.current = false;
  }, [branch]);

  const save = useCallback(async (): Promise<{ ok: true } | { ok: false; error: Error }> => {
    if (!branch || !client) return { ok: false, error: new Error('Modal not ready') };
    // Belt-and-suspenders: the Save button is already disabled while this is
    // set, but save() is also exported directly, so re-check here too.
    if (boardAttachError) return { ok: false, error: new Error(boardAttachError) };
    setSaving(true);
    try {
      const updates: BranchUpdate = {};
      if (generalChanged && canEditGeneral) {
        updates.board_id = general.boardId || undefined;
        updates.issue_url = general.issueUrl.trim() === '' ? null : general.issueUrl;
        updates.pull_request_url = general.prUrl.trim() === '' ? null : general.prUrl;
        if (!isTeammateBranch) updates.notes = general.notes.trim() === '' ? null : general.notes;
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
      // Persist a policy transition first. Moving an inherited branch is
      // intentionally rejected by the server until its current complete
      // package has been materialized as an override, so this ordering lets a
      // user choose Override and a new board in one explicit Save.
      if (permissionsChanged && capabilityPolicy) {
        const saved = await client
          .service('branches/:id/permissions')
          .patch(null, capabilityPolicy, { route: { id: branch.branch_id } });
        setCapabilityPolicyState(saved);
        initialCapabilityPolicyRef.current = structuredClone(saved);
      }
      if (Object.keys(updates).length > 0) {
        await client.service('branches').patch(branch.branch_id, updates as Partial<Branch>);
      }
      generalTouchedRef.current = false;
      teammateTouchedRef.current = false;
      permissionsTouchedRef.current = false;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      setSaving(false);
    }
  }, [
    branch,
    client,
    boardAttachError,
    generalChanged,
    canEditGeneral,
    general,
    isTeammateBranch,
    teammateChanged,
    teammate,
    permissionsChanged,
    capabilityPolicy,
  ]);

  return {
    general,
    setGeneral,
    generalChanged,
    teammate,
    setTeammate,
    teammateChanged,
    permissionsChanged,
    capabilityPolicy,
    setCapabilityPolicy,
    workspacePreferences,
    allUsers,
    allGroups,
    permissionsLoading,
    canViewPermissions,
    permissionsLoadError,
    canEditGeneral,
    canManagePolicy,
    canEditPermissions,
    canControlEnvironment,
    boardAttachChecking,
    boardAttachError,
    hasChanges,
    saving,
    save,
    reset,
  };
}
