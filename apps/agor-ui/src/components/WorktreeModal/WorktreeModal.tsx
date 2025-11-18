import type { AgorClient } from '@agor/core/api';
import type { Board, BoardEntityObject, Repo, Session, Worktree } from '@agor/core/types';
import { Modal, Tabs } from 'antd';
import { useState } from 'react';
import { ConceptsTab } from './tabs/ConceptsTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { GeneralTab, type WorktreeUpdate } from './tabs/GeneralTab';
import { ScheduleTab } from './tabs/ScheduleTab';

export interface WorktreeModalProps {
  open: boolean;
  onClose: () => void;
  worktree: Worktree | null;
  repo: Repo | null;
  sessions: Session[]; // Used for GeneralTab session count
  boards?: Board[];
  boardObjects?: BoardEntityObject[];
  client: AgorClient | null;
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
  boards = [],
  boardObjects = [],
  client,
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
                boards={boards}
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
            key: 'concepts',
            label: 'Concepts',
            children: <ConceptsTab worktree={worktree} client={client} />,
          },
          {
            key: 'schedule',
            label: 'Schedule',
            children: <ScheduleTab worktree={worktree} onUpdate={onUpdateWorktree} />,
          },
        ]}
      />
    </Modal>
  );
};
