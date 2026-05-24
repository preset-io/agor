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
import { Badge, Modal, Tabs, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { AssistantTab } from './tabs/AssistantTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { FilesTab } from './tabs/FilesTab';
import { type BranchUpdate, GeneralTab } from './tabs/GeneralTab';
import { ScheduleTab } from './tabs/ScheduleTab';
import { SessionsTab } from './tabs/SessionsTab';

export type BranchModalTab =
  | 'general'
  | 'assistant'
  | 'sessions'
  | 'environment'
  | 'files'
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
  const [activeTab, setActiveTab] = useState('general');

  // Sync active tab when modal opens — use defaultTab if specified, otherwise reset to general
  useEffect(() => {
    if (open) {
      setActiveTab(defaultTab || 'general');
    }
  }, [open, defaultTab]);

  const isAnAssistant = branch ? isAssistant(branch) : false;
  const assistantConfig = useMemo(() => (branch ? getAssistantConfig(branch) : null), [branch]);

  if (!branch || !repo) {
    return null;
  }

  const title = isAnAssistant
    ? `Assistant: ${assistantConfig?.displayName ?? branch.name}`
    : `Branch: ${branch.name}`;

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
                onUpdate={onUpdateBranch}
                onClose={onClose}
                client={client}
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
          client={client}
          currentUser={currentUser}
          onUpdate={onUpdateBranch}
          onArchiveOrDelete={onArchiveOrDelete}
          onClose={onClose}
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
        />
      ),
    },
    {
      key: 'files',
      label: 'Files',
      children: <FilesTab branch={branch} client={client} />,
    },
    {
      key: 'schedule',
      label: 'Schedules',
      children: (
        <ScheduleTab
          branch={branch}
          client={client}
          mcpServerById={mcpServerById}
          onOpenSession={(sessionId) => {
            onSessionClick?.(sessionId);
            onClose();
          }}
        />
      ),
    },
  ];

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      mask={{ closable: false }}
      styles={{
        body: { padding: 0, maxHeight: '80vh', overflowY: 'auto' },
      }}
    >
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
    </Modal>
  );
};
