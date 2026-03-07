import type { AgorClient } from '@agor/core/api';
import type {
  Board,
  BoardEntityObject,
  MCPServer,
  Repo,
  Session,
  User,
  Worktree,
} from '@agor/core/types';
import { getAssistantConfig, isAssistant } from '@agor/core/types';
import { Badge, Modal, Tabs, theme } from 'antd';
import { useMemo, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { AssistantTab } from './tabs/AssistantTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { FilesTab } from './tabs/FilesTab';
import { GeneralTab, type WorktreeUpdate } from './tabs/GeneralTab';
import { ScheduleTab } from './tabs/ScheduleTab';
import { SessionsTab } from './tabs/SessionsTab';

export interface WorktreeModalProps {
  open: boolean;
  onClose: () => void;
  worktree: Worktree | null;
  repo: Repo | null;
  sessions: Session[]; // Used for GeneralTab session count
  boardById?: Map<string, Board>;
  boardObjects?: BoardEntityObject[];
  mcpServerById?: Map<string, MCPServer>;
  client: AgorClient | null;
  currentUser?: User | null; // Current user for RBAC
  onUpdateWorktree?: (worktreeId: string, updates: WorktreeUpdate) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onArchiveOrDelete?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenSettings?: () => void; // Navigate to Settings → Repositories
  onSessionClick?: (sessionId: string) => void;
}

export const WorktreeModal: React.FC<WorktreeModalProps> = ({
  open,
  onClose,
  worktree,
  repo,
  sessions,
  boardById = new Map(),
  boardObjects = [],
  mcpServerById = new Map(),
  client,
  currentUser,
  onUpdateWorktree,
  onUpdateRepo,
  onArchiveOrDelete,
  onOpenSettings,
  onSessionClick,
}) => {
  const { token } = theme.useToken();
  const [activeTab, setActiveTab] = useState('general');

  const isAnAssistant = worktree ? isAssistant(worktree) : false;
  const assistantConfig = useMemo(
    () => (worktree ? getAssistantConfig(worktree) : null),
    [worktree]
  );

  if (!worktree || !repo) {
    return null;
  }

  const title = isAnAssistant
    ? `Assistant: ${assistantConfig?.displayName ?? worktree.name}`
    : `Worktree: ${worktree.name}`;

  const tabItems = [
    // Assistant tab — only for assistants, shown first
    ...(isAnAssistant
      ? [
          {
            key: 'assistant',
            label: 'Assistant',
            children: (
              <AssistantTab worktree={worktree} onUpdate={onUpdateWorktree} onClose={onClose} />
            ),
          },
        ]
      : []),
    {
      key: 'general',
      label: 'General',
      children: (
        <GeneralTab
          worktree={worktree}
          repo={repo}
          sessions={sessions}
          boards={mapToArray(boardById)}
          client={client}
          currentUser={currentUser}
          onUpdate={onUpdateWorktree}
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
          worktree={worktree}
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
          worktree={worktree}
          repo={repo}
          client={client}
          onUpdateRepo={onUpdateRepo}
          onUpdateWorktree={onUpdateWorktree}
        />
      ),
    },
    {
      key: 'files',
      label: 'Files',
      children: <FilesTab worktree={worktree} client={client} />,
    },
    {
      key: 'schedule',
      label: 'Schedule',
      children: (
        <ScheduleTab
          worktree={worktree}
          mcpServerById={mcpServerById}
          onUpdate={onUpdateWorktree}
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
