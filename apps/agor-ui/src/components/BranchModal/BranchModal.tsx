import type {
  AgorClient,
  BoardEntityObject,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { Badge, Button, Drawer, Grid, Modal, Space, Tabs, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectMcpServerById, selectUserById } from '../../store/selectors';
import {
  type ActionErrorCopy,
  describeActionError,
  isInFlightConnectionLossError,
} from '../../utils/connectionErrors';
import { useThemedMessage } from '../../utils/message';
import { ActionErrorNotice, CompactNotice } from '../CompactNotice';
import { DrillInFrame, useDiscardConfirm } from '../SettingsModal/SettingsDrill';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { FilesTab } from './tabs/FilesTab';
import { GeneralTab } from './tabs/GeneralTab';
import { KnowledgeTab } from './tabs/KnowledgeTab';
import { PermissionsTab } from './tabs/PermissionsTab';
import { ScheduleTab } from './tabs/ScheduleTab';
import { SessionsTab } from './tabs/SessionsTab';
import { TeammateTab } from './tabs/TeammateTab';
import {
  type BranchModalSaveResult,
  type BranchUpdate,
  useBranchModalForm,
} from './useBranchModalForm';

export type BranchModalTab =
  | 'general'
  | 'teammate'
  | 'knowledge'
  | 'sessions'
  | 'environment'
  | 'files'
  | 'permissions'
  | 'schedule';

export interface BranchModalProps {
  open: boolean;
  onClose: () => void;
  branch: Branch | null;
  repo: Repo | null;
  sessions: Session[]; // Used for GeneralTab session count
  boardObjects?: BoardEntityObject[];
  client: AgorClient | null;
  currentUser?: User | null; // Current user for RBAC
  // Used by EnvironmentTab for its independent start/stop/snapshot actions.
  // The General / Teammate / Permissions form does NOT route through this —
  // it calls `client.service('branches').patch()` directly so errors bubble.
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onArchiveOrDelete?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
  onOpenSettings?: () => void; // Navigate to Settings → Repositories
  onSessionClick?: (sessionId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  defaultTab?: BranchModalTab; // Open modal to a specific tab
  /**
   * Render the body as an in-place drill-in (no outer Modal) for the Workspace
   * Settings shell: the shared drill footer drives Save/Cancel and the
   * unsaved-changes guard. Default false → the standalone Modal used everywhere
   * else is unchanged.
   */
  embedded?: boolean;
  presentation?: 'modal' | 'bottom-sheet';
}

export const BranchModal: React.FC<BranchModalProps> = ({
  open,
  onClose,
  branch,
  repo,
  sessions,
  boardObjects = [],
  client,
  currentUser,
  onUpdateBranch,
  onUpdateRepo,
  onArchiveOrDelete,
  onOpenSettings,
  onSessionClick,
  onExecuteScheduleNow,
  defaultTab,
  embedded = false,
  presentation = 'modal',
}) => {
  // Entity maps are read from the store rather than drilled through props so
  // the App shell doesn't have to forward them into every modal.
  const boardById = useAgorStore(selectBoardById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const userById = useAgorStore(selectUserById);
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const { showSuccess } = useThemedMessage();
  const [saveError, setSaveError] = useState<ActionErrorCopy | null>(null);
  // The open Schedules form's dirty getter; joins the branch form in the
  // drill-in leave guard (Back, nav switch, close) and gates Save's close.
  const scheduleDraftRef = useRef<(() => boolean) | null>(null);
  const setScheduleDraft = useCallback((isDirty: (() => boolean) | null) => {
    scheduleDraftRef.current = isDirty;
  }, []);
  const isScheduleDirty = () => scheduleDraftRef.current?.() ?? false;
  const confirmDiscard = useDiscardConfirm();
  // Teammate records render a 'teammate' tab FIRST (see tabItems below), so the
  // default tab must follow the record kind — otherwise a teammate opens on its
  // second tab. Lazy init avoids a flash of 'general' before the open effect runs.
  const [activeTab, setActiveTab] = useState<BranchModalTab>(
    () => defaultTab ?? (branch && isTeammate(branch) ? 'teammate' : 'general')
  );

  const form = useBranchModalForm({
    branch,
    client,
    currentUser,
    open,
  });
  const permissionUsers = useMemo(() => {
    const knownUsers = new Map(userById);
    for (const user of form.allUsers) knownUsers.set(user.user_id, user);
    return [...knownUsers.values()];
  }, [userById, form.allUsers]);

  // Sync active tab when the modal opens — use defaultTab if specified, else the
  // record's own first tab ('teammate' for teammates, 'general' otherwise).
  // `branch` is read at open-time only and deliberately kept out of the deps: a
  // realtime branch re-emit while the modal is open must NOT reset the tab the
  // user has since clicked into.
  // biome-ignore lint/correctness/useExhaustiveDependencies: branch read at open-time only (see comment)
  useEffect(() => {
    if (open) {
      setActiveTab(
        defaultTab === 'permissions' && !form.canViewPermissions
          ? 'general'
          : (defaultTab ?? (branch && isTeammate(branch) ? 'teammate' : 'general'))
      );
    }
  }, [open, defaultTab, form.canViewPermissions]);

  // A feature-flag change can remove the active tab while the modal remains
  // open. Do not leave Ant Tabs pointing at a now-unmounted permissions pane.
  useEffect(() => {
    if (activeTab === 'permissions' && !form.canViewPermissions) {
      setActiveTab('general');
    }
  }, [activeTab, form.canViewPermissions]);

  // A save settling after close or a branch switch must not show its banner on the next form.
  const formSessionRef = useRef(0);
  const branchId = branch?.branch_id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: open and branchId start a new form session
  useEffect(() => {
    formSessionRef.current += 1;
    setSaveError(null);
  }, [open, branchId]);

  const isATeammate = branch ? isTeammate(branch) : false;
  const teammateConfig = useMemo(() => (branch ? getTeammateConfig(branch) : null), [branch]);

  if (!branch) {
    return null;
  }

  if (!repo) {
    const unavailable = (
      <CompactNotice
        type="warning"
        message="This branch's repository hasn't loaded, so you can't edit it yet."
        actions={onOpenSettings ? [{ label: 'Open repositories', onClick: onOpenSettings }] : []}
      />
    );
    // Drill-in mode renders in place, never a dialog over the Settings modal.
    if (embedded) {
      return <DrillInFrame title={`Branch: ${branch.name}`}>{unavailable}</DrillInFrame>;
    }
    return presentation === 'bottom-sheet' || compact ? (
      <Drawer
        title={`Branch: ${branch.name}`}
        placement="bottom"
        size="min(52dvh, 440px)"
        open={open}
        onClose={onClose}
        footer={<Button onClick={onClose}>Close</Button>}
      >
        {unavailable}
      </Drawer>
    ) : (
      <Modal title={`Branch: ${branch.name}`} open={open} onCancel={onClose} footer={null}>
        {unavailable}
      </Modal>
    );
  }

  const title = isATeammate
    ? `Teammate: ${teammateConfig?.displayName ?? branch.name}`
    : `Branch: ${branch.name}`;

  const handleSave = async () => {
    setSaveError(null);
    const session = formSessionRef.current;
    const result = await form.save();
    const current = session === formSessionRef.current;
    if (result.ok) {
      showSuccess(isATeammate ? 'Teammate updated.' : 'Branch updated.');
      if (!current) return;
      // The branch is saved, but an open schedule draft is not part of it: show
      // the draft and ask before closing; Keep editing stays on it.
      if (isScheduleDirty()) {
        setActiveTab('schedule');
        confirmDiscard(true, onClose);
      } else {
        onClose();
      }
    } else if (current) {
      setSaveError(
        describeSaveFailure(result, isATeammate ? 'save the teammate' : 'save the branch')
      );
    }
  };

  const tabItems = [
    // Teammate tab — only for teammates, shown first
    ...(isATeammate
      ? [
          {
            key: 'teammate',
            label: 'Teammate',
            children: (
              <TeammateTab
                branch={branch}
                client={client}
                onRetired={onClose}
                canEdit={form.canEditGeneral}
                state={form.teammate}
                setField={form.setTeammate}
              />
            ),
          },
        ]
      : []),
    {
      key: 'general',
      label: 'General',
      children: (
        <GeneralTab
          client={client}
          currentUser={currentUser}
          branch={branch}
          repo={repo}
          sessions={sessions}
          boards={mapToArray(boardById)}
          mcpServers={mapToArray(mcpServerById)}
          canEdit={form.canEditGeneral}
          state={form.general}
          setField={form.setGeneral}
          onArchiveOrDelete={onArchiveOrDelete}
          boardAttachChecking={form.boardAttachChecking}
          boardAttachError={form.boardAttachError}
        />
      ),
    },
    {
      key: 'sessions',
      label: (
        <span>
          Sessions{' '}
          <Badge
            count={sessions.length}
            showZero
            size="small"
            style={{ backgroundColor: token.colorPrimaryBgHover }}
          />
        </span>
      ),
      children: (
        <SessionsTab
          branch={branch}
          sessions={sessions}
          client={client}
          onSessionClick={(sessionId) => {
            onSessionClick?.(sessionId);
            onClose();
          }}
        />
      ),
    },
    {
      key: 'environment',
      label: 'Environment',
      children: (
        <EnvironmentTab
          branch={branch}
          repo={repo}
          client={client}
          onUpdateRepo={onUpdateRepo}
          onUpdateBranch={onUpdateBranch}
          canControlEnvironment={form.canControlEnvironment}
        />
      ),
    },
    {
      key: 'files',
      label: 'Files',
      children: <FilesTab branch={branch} client={client} />,
    },
    ...(form.canViewPermissions
      ? [
          {
            key: 'permissions',
            label: 'Permissions',
            children: (
              <PermissionsTab
                branchId={branch.branch_id}
                onTransferred={onClose}
                saving={form.saving}
                loading={form.permissionsLoading}
                canManageAccess={form.canManagePolicy}
                allGroups={form.allGroups}
                currentUser={currentUser}
                client={client}
                error={form.permissionsLoadError}
                sessions={sessions}
                permissionUsers={permissionUsers}
                capabilityPolicy={form.capabilityPolicy}
                onCapabilityPolicyChange={form.setCapabilityPolicy}
                workspacePreferences={form.workspacePreferences}
              />
            ),
          },
        ]
      : []),
    {
      key: 'schedule',
      label: 'Schedules',
      children: (
        <ScheduleTab
          branch={branch}
          client={client}
          mcpServerById={mcpServerById}
          currentUser={currentUser}
          userById={userById}
          onOpenSession={(sessionId) => {
            onSessionClick?.(sessionId);
            onClose();
          }}
          onDraftChange={setScheduleDraft}
        />
      ),
    },
    // Knowledge is teammate-only and intentionally last for now: it is
    // configuration-adjacent but less central than the primary branch/session tabs.
    ...(isATeammate
      ? [
          {
            key: 'knowledge',
            label: 'Teammate Knowledge',
            children: (
              <KnowledgeTab branch={branch} client={client} canEdit={form.canEditGeneral} />
            ),
          },
        ]
      : []),
  ];

  // Modal-level footer: one Save action for all form-contributing tabs
  // (General, Teammate, Permissions). Tabs like Environment / Sessions /
  // Files / Schedules have their own actions outside the form.
  const canSave =
    (form.canEditGeneral || form.canEditPermissions) &&
    form.hasChanges &&
    !form.saving &&
    !form.boardAttachError &&
    !form.boardAttachChecking;

  const footer = (
    <Space>
      {form.hasChanges && (
        <Button
          onClick={() => {
            setSaveError(null);
            form.reset();
          }}
          disabled={form.saving}
          aria-label="Reset changes"
        >
          Reset
        </Button>
      )}
      <Button onClick={onClose} disabled={form.saving}>
        Close
      </Button>
      <Button
        type="primary"
        onClick={handleSave}
        loading={form.saving}
        disabled={!canSave}
        aria-label="Save changes"
      >
        Save Changes
      </Button>
    </Space>
  );

  const contents = (
    <>
      {form.permissionsLoadError && (
        <ActionErrorNotice
          error={describeActionError("load this branch's permissions", form.permissionsLoadError, {
            idempotent: true,
          })}
          action={{ label: 'Try again', onClick: form.reloadPermissions }}
          style={{ margin: '12px 16px 0' }}
        />
      )}
      {saveError && <ActionErrorNotice error={saveError} style={{ margin: '12px 16px 0' }} />}
      <Tabs
        tabPosition="top"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BranchModalTab)}
        items={tabItems}
      />
    </>
  );

  // Drill-in mode: no outer Modal. The shared shell footer renders Save/Cancel
  // (Save only when there is something saveable) and runs the unsaved-changes
  // guard from `dirty`; Reset moves to the header's extra slot.
  if (embedded) {
    return (
      <DrillInFrame
        title={title}
        dirty={() => form.hasChanges || isScheduleDirty()}
        saving={form.saving}
        saveLabel="Save Changes"
        onSave={canSave ? handleSave : undefined}
        extra={
          form.hasChanges ? (
            <Button
              onClick={() => {
                setSaveError(null);
                form.reset();
              }}
              disabled={form.saving}
              aria-label="Reset changes"
            >
              Reset
            </Button>
          ) : null
        }
      >
        {contents}
      </DrillInFrame>
    );
  }

  // Mobile / explicit bottom-sheet: a Drawer instead of the centered Modal.
  if (presentation === 'bottom-sheet' || compact) {
    return (
      <Drawer
        title={title}
        placement="bottom"
        size="94dvh"
        open={open}
        onClose={onClose}
        mask={{ closable: false }}
        footer={footer}
        styles={{ body: { padding: '12px 16px', overflowY: 'auto' } }}
      >
        {contents}
      </Drawer>
    );
  }

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={compact ? 'calc(100vw - 16px)' : 900}
      style={{ top: compact ? 8 : undefined }}
      mask={{ closable: false }}
      styles={{
        body: {
          padding: 0,
          height: compact ? 'calc(100dvh - 150px)' : undefined,
          maxHeight: compact ? 'none' : '80vh',
          overflowY: 'auto',
        },
      }}
    >
      {contents}
    </Modal>
  );
};

function describeSaveFailure(
  result: Extract<BranchModalSaveResult, { ok: false }>,
  action: string
): ActionErrorCopy {
  if (result.notReady) return { message: 'Still loading. Try again in a moment.', raw: null };
  if (!result.permissionsSaved)
    return describeActionError(action, result.error, { idempotent: true });
  return {
    message: isInFlightConnectionLossError(result.error)
      ? 'Permissions saved, but the connection to Agor dropped before the other changes were confirmed.'
      : "Permissions saved, but the other changes weren't.",
    raw: result.error.message,
  };
}
