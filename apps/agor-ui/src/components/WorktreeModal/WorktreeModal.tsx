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
import { Modal, Tabs } from 'antd';
import { useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { FilesTab } from './tabs/FilesTab';
import { GeneralTab, type WorktreeUpdate } from './tabs/GeneralTab';
import { ScheduleTab } from './tabs/ScheduleTab';

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
}) => {
  const [activeTab, setActiveTab] = useState('general');

  if (!worktree || !repo) {
    return null;
  }

  return (
    <Modal
      title={`Worktree: ${worktree.name}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      maskClosable={false}
      styles={{
        body: { padding: 0, maxHeight: '80vh', overflowY: 'auto' },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
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
        ]}
      />
    </Modal>
  );
};
