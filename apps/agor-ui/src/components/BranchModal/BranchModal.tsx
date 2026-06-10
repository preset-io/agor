import type {
  AgorClient,
  Board,
  BoardEntityObject,
  Branch,
  MCPServer,
  Repo,
  Session,
  User,
} from '@agor-live/client';
import { getAssistantConfig, isAssistant } from '@agor-live/client';
import { Badge, Button, Modal, Space, Tabs, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '../../utils/message';
import { AssistantTab } from './tabs/AssistantTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { FilesTab } from './tabs/FilesTab';
import { GeneralTab } from './tabs/GeneralTab';
import { KnowledgeTab } from './tabs/KnowledgeTab';
import { PermissionsTab } from './tabs/PermissionsTab';
import { ScheduleTab } from './tabs/ScheduleTab';
import { SessionsTab } from './tabs/SessionsTab';
import { type BranchUpdate, useBranchModalForm } from './useBranchModalForm';

export type BranchModalTab =
  | 'general'
  | 'assistant'
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
  boardById?: Map<string, Board>;
  boardObjects?: BoardEntityObject[];
  mcpServerById?: Map<string, MCPServer>;
  client: AgorClient | null;
  currentUser?: User | null; // Current user for RBAC
  // Used by EnvironmentTab for its independent start/stop/snapshot actions.
  // The General / Assistant / Permissions form does NOT route through this —
  // it calls `client.service('branches').patch()` directly so errors bubble.
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onArchiveOrDelete?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenSettings?: () => void; // Navigate to Settings → Repositories
  onSessionClick?: (sessionId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  defaultTab?: BranchModalTab; // Open modal to a specific tab
}

export const BranchModal: React.FC<BranchModalProps> = ({
  open,
  onClose,
  branch,
  repo,
  sessions,
  boardById = new Map(),
  boardObjects = [],
  mcpServerById = new Map(),
  client,
  currentUser,
  onUpdateBranch,
  onUpdateRepo,
  onArchiveOrDelete,
  onOpenSettings,
  onSessionClick,
  onExecuteScheduleNow,
  defaultTab,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [activeTab, setActiveTab] = useState<BranchModalTab>('general');

  const form = useBranchModalForm({
    branch,
    client,
    currentUser,
    open,
  });
  const userById = useMemo(
    () => new Map(form.allUsers.map((user) => [user.user_id, user])),
    [form.allUsers]
  );
  const branchBoard = boardById.get(form.general.boardId || branch?.board_id || '');

  // Sync active tab when modal opens — use defaultTab if specified, otherwise reset to general
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab || 'general');
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

  const isAnAssistant = branch ? isAssistant(branch) : false;
  const assistantConfig = useMemo(() => (branch ? getAssistantConfig(branch) : null), [branch]);

  if (!branch || !repo) {
    return null;
  }

  const title = isAnAssistant
    ? `Assistant: ${assistantConfig?.displayName ?? branch.name}`
    : `Branch: ${branch.name}`;

  const handleSave = async () => {
    const result = await form.save();
    if (result.ok) {
      showSuccess(isAnAssistant ? 'Assistant updated' : 'Branch updated');
      onClose();
    } else {
      showError(result.error.message || 'Failed to save changes');
    }
  };

  const tabItems = [
    // Assistant tab — only for assistants, shown first
    ...(isAnAssistant
      ? [
          {
            key: 'assistant',
            label: 'Assistant',
            children: (
              <AssistantTab
                branch={branch}
                canEdit={form.canEditGeneral}
                state={form.assistant}
                setField={form.setAssistant}
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
    // Permissions tab — shown for RBAC-capable admins/owners. Keep it visible
    // while owner data is loading so confirmed owners do not see the tab
    // disappear just because async permissions metadata has not arrived yet.
    ...(form.canViewPermissions
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
        />
      ),
    },
    // Knowledge is assistant-only and intentionally last for now: it is
    // configuration-adjacent but less central than the primary branch/session tabs.
    ...(isAnAssistant
      ? [
          {
            key: 'knowledge',
            label: 'Knowledge',
            children: (
              <KnowledgeTab branch={branch} client={client} canEdit={form.canEditGeneral} />
            ),
          },
        ]
      : []),
  ];

  // Modal-level footer: one Save action for all form-contributing tabs
  // (General, Assistant, Permissions). Tabs like Environment / Sessions /
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
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BranchModalTab)}
        items={tabItems}
      />
    </Modal>
  );
};
