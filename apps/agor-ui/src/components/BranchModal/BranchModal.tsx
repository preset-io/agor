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
import { Badge, Button, Modal, Space, Tabs, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectMcpServerById, selectUserById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { DrillInFrame } from '../SettingsModal/SettingsDrill';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { FilesTab } from './tabs/FilesTab';
import { GeneralTab } from './tabs/GeneralTab';
import { KnowledgeTab } from './tabs/KnowledgeTab';
import { PermissionsTab } from './tabs/PermissionsTab';
import { ScheduleTab } from './tabs/ScheduleTab';
import { SessionsTab } from './tabs/SessionsTab';
import { TeammateTab } from './tabs/TeammateTab';
import { type BranchUpdate, useBranchModalForm } from './useBranchModalForm';

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
  onArchiveOrDelete?: (branchId: string, options: BranchArchiveOrDeleteOptions) => void;
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
}) => {
  // Entity maps are read from the store rather than drilled through props so
  // the App shell doesn't have to forward them into every modal.
  const boardById = useAgorStore(selectBoardById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const userById = useAgorStore(selectUserById);
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
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
  const branchBoard = boardById.get(form.general.boardId || branch?.board_id || '');

  // Sync active tab when the modal opens — use defaultTab if specified, else the
  // record's own first tab ('teammate' for teammates, 'general' otherwise).
  // `branch` is read at open-time only and deliberately kept out of the deps: a
  // realtime branch re-emit while the modal is open must NOT reset the tab the
  // user has since clicked into.
  // biome-ignore lint/correctness/useExhaustiveDependencies: branch read at open-time only (see comment)
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab ?? (branch && isTeammate(branch) ? 'teammate' : 'general'));
    }
  }, [open, defaultTab]);

  // Surface owners-load failures to the user. Without this, a non-admin owner
  // hitting a network/server error would see canEdit silently flip false with
  // no visible reason. Toasted once per error transition.
  useEffect(() => {
    if (form.ownersLoadError) {
      showError(`Failed to load branch permissions: ${form.ownersLoadError.message}`);
    }
  }, [form.ownersLoadError, showError]);

  const isATeammate = branch ? isTeammate(branch) : false;
  const teammateConfig = useMemo(() => (branch ? getTeammateConfig(branch) : null), [branch]);

  if (!branch || !repo) {
    return null;
  }

  const title = isATeammate
    ? `Teammate: ${teammateConfig?.displayName ?? branch.name}`
    : `Branch: ${branch.name}`;

  const handleSave = async () => {
    const result = await form.save();
    if (result.ok) {
      showSuccess(isATeammate ? 'Teammate updated' : 'Branch updated');
      onClose();
    } else {
      showError(result.error.message || 'Failed to save changes');
    }
  };

  // Tabs shared by both branch and teammate records, in their common order.
  const sessionsTab = {
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
  };
  const environmentTab = {
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
  };
  const filesTab = {
    key: 'files',
    label: 'Files',
    children: <FilesTab branch={branch} client={client} />,
  };
  // Permissions tab — shown for RBAC-capable admins/owners. Keep it visible
  // while owner data is loading so confirmed owners do not see the tab
  // disappear just because async permissions metadata has not arrived yet.
  const permissionsTabs = form.canViewPermissions
    ? [
        {
          key: 'permissions',
          label: 'Permissions',
          children: (
            <PermissionsTab
              loadingOwners={form.loadingOwners}
              canEdit={form.canEditPermissions}
              allUsers={form.allUsers}
              allGroups={form.allGroups}
              groupGrantsStatus={form.groupGrantsStatus}
              groupGrantsError={form.groupGrantsError}
              currentUser={currentUser}
              client={client}
              board={branchBoard}
              state={form.permissions}
              setField={form.setPermissions}
              ownersLoadError={form.ownersLoadError}
            />
          ),
        },
      ]
    : [];
  const scheduleTab = {
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
      />
    ),
  };

  // Teammates lead with the Teammate tab (Board + default MCP servers are folded
  // into it) followed by Knowledge, and drop the branch-only General tab; regular
  // branches keep General first. The rest of the order is shared.
  const tabItems = isATeammate
    ? [
        {
          key: 'teammate',
          label: 'Teammate',
          children: (
            <TeammateTab
              branch={branch}
              canEdit={form.canEditGeneral}
              state={form.teammate}
              setField={form.setTeammate}
              boards={mapToArray(boardById)}
              mcpServers={mapToArray(mcpServerById)}
              general={form.general}
              setGeneral={form.setGeneral}
            />
          ),
        },
        {
          key: 'knowledge',
          label: 'Knowledge',
          children: <KnowledgeTab branch={branch} client={client} canEdit={form.canEditGeneral} />,
        },
        sessionsTab,
        environmentTab,
        filesTab,
        ...permissionsTabs,
        scheduleTab,
      ]
    : [
        {
          key: 'general',
          label: 'General',
          children: (
            <GeneralTab
              branch={branch}
              repo={repo}
              sessions={sessions}
              boards={mapToArray(boardById)}
              mcpServers={mapToArray(mcpServerById)}
              canEdit={form.canEditGeneral}
              state={form.general}
              setField={form.setGeneral}
              onArchiveOrDelete={onArchiveOrDelete}
            />
          ),
        },
        sessionsTab,
        environmentTab,
        filesTab,
        ...permissionsTabs,
        scheduleTab,
      ];

  // Modal-level footer: one Save action for all form-contributing tabs
  // (General, Teammate, Permissions). Tabs like Environment / Sessions /
  // Files / Schedules have their own actions outside the form.
  const canSave =
    (form.canEditGeneral || form.canEditPermissions) && form.hasChanges && !form.saving;

  const footer = (
    <Space>
      {form.hasChanges && (
        <Button onClick={form.reset} disabled={form.saving} aria-label="Reset changes">
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

  const tabs = (
    <Tabs
      activeKey={activeTab}
      onChange={(key) => setActiveTab(key as BranchModalTab)}
      items={tabItems}
    />
  );

  // Drill-in mode: no outer Modal. The shared shell footer renders Save/Cancel
  // (Save only when there is something saveable) and runs the unsaved-changes
  // guard from `dirty`; Reset moves to the header's extra slot.
  if (embedded) {
    return (
      <DrillInFrame
        title={title}
        dirty={form.hasChanges}
        saving={form.saving}
        saveLabel="Save Changes"
        onSave={canSave ? handleSave : undefined}
        extra={
          form.hasChanges ? (
            <Button onClick={form.reset} disabled={form.saving} aria-label="Reset changes">
              Reset
            </Button>
          ) : null
        }
      >
        {tabs}
      </DrillInFrame>
    );
  }

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={footer}
      width={900}
      mask={{ closable: false }}
      styles={{
        body: { padding: 0, maxHeight: '80vh', overflowY: 'auto' },
      }}
    >
      {tabs}
    </Modal>
  );
};
