import type { AgorClient } from '@agor/core/api';
import type {
  Board,
  BoardEntityObject,
  CreateMCPServerInput,
  CreateUserInput,
  MCPServer,
  Repo,
  Session,
  UpdateMCPServerInput,
  UpdateUserInput,
  User,
  Worktree,
} from '@agor/core/types';
import { Modal, Tabs } from 'antd';
import { useState } from 'react';
import { WorktreeModal } from '../WorktreeModal';
import { AboutTab } from './AboutTab';
import { AgenticToolsSection } from './AgenticToolsSection';
import { BoardsTable } from './BoardsTable';
import { MCPServersTable } from './MCPServersTable';
import { ReposTable } from './ReposTable';
import { UsersTable } from './UsersTable';
import { WorktreesTable } from './WorktreesTable';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null; // Still needed for WorktreeModal
  currentUser?: User | null; // Current logged-in user
  boards: Board[];
  boardObjects: BoardEntityObject[];
  repos: Repo[];
  worktrees: Worktree[];
  sessions: Session[];
  users: User[];
  mcpServers: MCPServer[];
  activeTab?: string; // Control which tab is shown when modal opens
  onTabChange?: (tabKey: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string) => void;
  onDeleteWorktree?: (worktreeId: string, deleteFromFilesystem: boolean) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
  onCreateWorktree?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
    }
  ) => Promise<Worktree | null>;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: CreateMCPServerInput) => void;
  onUpdateMCPServer?: (serverId: string, updates: UpdateMCPServerInput) => void;
  onDeleteMCPServer?: (serverId: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  client,
  currentUser,
  boards,
  boardObjects,
  repos,
  worktrees,
  sessions,
  users,
  mcpServers,
  activeTab = 'boards',
  onTabChange,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onCreateRepo,
  onUpdateRepo,
  onDeleteRepo,
  onDeleteWorktree,
  onUpdateWorktree,
  onCreateWorktree,
  onStartEnvironment,
  onStopEnvironment,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onUpdateMCPServer,
  onDeleteMCPServer,
}) => {
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [worktreeSessions, setWorktreeSessions] = useState<Session[]>([]);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);

  const handleWorktreeRowClick = (worktree: Worktree) => {
    // Snapshot the data when opening modal
    setSelectedWorktree(worktree);
    setSelectedRepo(repos.find(r => r.repo_id === worktree.repo_id) || null);
    setWorktreeSessions(sessions.filter(s => s.worktree_id === worktree.worktree_id));
    setWorktreeModalOpen(true);
  };

  const handleWorktreeModalClose = () => {
    setWorktreeModalOpen(false);
    // Clear after modal closes
    setSelectedWorktree(null);
    setSelectedRepo(null);
    setWorktreeSessions([]);
  };

  // Wrapper to close modal after deletion
  const handleDeleteWorktreeWithClose = async (
    worktreeId: string,
    deleteFromFilesystem: boolean
  ) => {
    await onDeleteWorktree?.(worktreeId, deleteFromFilesystem);
    handleWorktreeModalClose();
  };
  return (
    <Modal
      title="Settings"
      open={open}
      onCancel={onClose}
      footer={null}
      width={1200}
      style={{ minHeight: 600 }}
      styles={{ body: { minHeight: 500 } }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={onTabChange}
        items={[
          {
            key: 'boards',
            label: 'Boards',
            children: (
              <BoardsTable
                boards={boards}
                sessions={sessions}
                worktrees={worktrees}
                onCreate={onCreateBoard}
                onUpdate={onUpdateBoard}
                onDelete={onDeleteBoard}
              />
            ),
          },
          {
            key: 'repos',
            label: 'Repositories',
            children: (
              <ReposTable
                repos={repos}
                onCreate={onCreateRepo}
                onUpdate={onUpdateRepo}
                onDelete={onDeleteRepo}
              />
            ),
          },
          {
            key: 'worktrees',
            label: 'Worktrees & Environments',
            children: (
              <WorktreesTable
                worktrees={worktrees}
                repos={repos}
                boards={boards}
                sessions={sessions}
                onDelete={onDeleteWorktree}
                onCreate={onCreateWorktree}
                onRowClick={handleWorktreeRowClick}
                onStartEnvironment={onStartEnvironment}
                onStopEnvironment={onStopEnvironment}
              />
            ),
          },
          {
            key: 'mcp',
            label: 'MCP Servers',
            children: (
              <MCPServersTable
                mcpServers={mcpServers}
                onCreate={onCreateMCPServer}
                onUpdate={onUpdateMCPServer}
                onDelete={onDeleteMCPServer}
              />
            ),
          },
          {
            key: 'agentic-tools',
            label: 'Agentic Tools',
            children: <AgenticToolsSection client={client} />,
          },
          {
            key: 'users',
            label: 'Users',
            children: (
              <UsersTable
                users={users}
                mcpServers={mcpServers}
                onCreate={onCreateUser}
                onUpdate={onUpdateUser}
                onDelete={onDeleteUser}
              />
            ),
          },
          {
            key: 'about',
            label: 'About',
            children: (
              <AboutTab
                connected={client?.io?.connected ?? false}
                connectionError={undefined}
                isAdmin={currentUser?.role === 'admin'}
              />
            ),
          },
        ]}
      />
      <WorktreeModal
        open={worktreeModalOpen}
        onClose={handleWorktreeModalClose}
        worktree={selectedWorktree}
        repo={selectedRepo}
        sessions={worktreeSessions}
        boards={boards}
        boardObjects={boardObjects}
        client={client}
        onUpdateWorktree={onUpdateWorktree}
        onUpdateRepo={onUpdateRepo}
        onDelete={handleDeleteWorktreeWithClose}
        onOpenSettings={onClose} // Close worktree modal and keep settings modal open
      />
    </Modal>
  );
};
