import type { Application } from '@agor/core/feathers';
import type {
  Board,
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
import { BoardsTable } from './BoardsTable';
import { MCPServersTable } from './MCPServersTable';
import { ReposTable } from './ReposTable';
import { UsersTable } from './UsersTable';
import { WorktreesTable } from './WorktreesTable';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  client: Application | null; // Still needed for WorktreeModal
  boards: Board[];
  repos: Repo[];
  worktrees: Worktree[];
  sessions: Session[];
  users: User[];
  mcpServers: MCPServer[];
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onCreateRepo?: (data: { url: string; slug: string }) => void;
  onDeleteRepo?: (repoId: string) => void;
  onDeleteWorktree?: (worktreeId: string) => void;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
  onCreateWorktree?: (
    repoId: string,
    data: { name: string; ref: string; createBranch: boolean }
  ) => void;
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
  boards,
  repos,
  worktrees,
  sessions,
  users,
  mcpServers,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onCreateRepo,
  onDeleteRepo,
  onDeleteWorktree,
  onUpdateWorktree,
  onCreateWorktree,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onUpdateMCPServer,
  onDeleteMCPServer,
}) => {
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);

  const handleWorktreeRowClick = (worktree: Worktree) => {
    setSelectedWorktree(worktree);
    setWorktreeModalOpen(true);
  };

  const handleWorktreeModalClose = () => {
    setWorktreeModalOpen(false);
    setSelectedWorktree(null);
  };

  // Get repo for selected worktree
  const selectedRepo = selectedWorktree
    ? repos.find(r => r.repo_id === selectedWorktree.repo_id) || null
    : null;

  // Get sessions for selected worktree
  const worktreeSessions = selectedWorktree
    ? sessions.filter(s => s.worktree_id === selectedWorktree.worktree_id)
    : [];
  return (
    <Modal
      title="Settings"
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      styles={{
        body: { padding: '24px 0' },
      }}
    >
      <Tabs
        defaultActiveKey="boards"
        items={[
          {
            key: 'boards',
            label: 'Boards',
            children: (
              <BoardsTable
                boards={boards}
                onCreate={onCreateBoard}
                onUpdate={onUpdateBoard}
                onDelete={onDeleteBoard}
              />
            ),
          },
          {
            key: 'repos',
            label: 'Repositories',
            children: <ReposTable repos={repos} onCreate={onCreateRepo} onDelete={onDeleteRepo} />,
          },
          {
            key: 'worktrees',
            label: 'Worktrees',
            children: (
              <WorktreesTable
                worktrees={worktrees}
                repos={repos}
                onDelete={onDeleteWorktree}
                onCreate={onCreateWorktree}
                onRowClick={handleWorktreeRowClick}
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
            key: 'users',
            label: 'Users',
            children: (
              <UsersTable
                users={users}
                onCreate={onCreateUser}
                onUpdate={onUpdateUser}
                onDelete={onDeleteUser}
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
        client={client}
        onUpdate={onUpdateWorktree}
        onDelete={onDeleteWorktree}
        onOpenSettings={onClose} // Close worktree modal and keep settings modal open
      />
    </Modal>
  );
};
