import type { Board, Repo } from '@agor/core/types';
import {
  AppstoreOutlined,
  BranchesOutlined,
  FolderOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Alert, Button, Modal, Tabs } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantTabResult } from './tabs/AssistantTab';
import { AssistantTab } from './tabs/AssistantTab';
import { BoardTab } from './tabs/BoardTab';
import type { RepoTabResult } from './tabs/RepoTab';
import { RepoTab } from './tabs/RepoTab';
import type { WorktreeTabConfig } from './tabs/WorktreeTab';
import { WorktreeTab } from './tabs/WorktreeTab';

type ActiveTab = 'worktree' | 'assistant' | 'board' | 'repository';

const PURPOSE_TEXT: Record<ActiveTab, string> = {
  worktree:
    'Perfect for coding tasks. Requires a code repository. Generally ephemeral \u2014 has the lifecycle of a feature\u2019s development. Can include multiple AI sessions.',
  assistant:
    'Long-lived agent with an identity, purpose, and goals. Think of it like an employee. Assistants have memory, can build their own skills, can coordinate multiple coding agents, typically operate on their own Agor board, and can act proactively.',
  board:
    'A spatial canvas for organizing work. Boards contain worktrees, zones, cards, and other visual elements. Use boards to create workspaces for teams, projects, or assistants.',
  repository:
    'Connect a code repository to Agor. Repositories can be cloned from GitHub or registered from a local path. Once connected, you can create worktrees for coding tasks.',
};

const ACTION_LABELS: Record<ActiveTab, string> = {
  worktree: 'Create Worktree',
  assistant: 'Create Assistant',
  board: 'Create Board',
  repository: 'Add Repository',
};

export interface CreateDialogProps {
  open: boolean;
  onClose: () => void;
  repoById: Map<string, Repo>;
  boardById: Map<string, Board>;
  currentBoardId?: string;
  defaultPosition?: { x: number; y: number };
  defaultTab?: ActiveTab;
  onCreateWorktree: (config: WorktreeTabConfig) => void;
  onCreateBoard: (board: Partial<Board>) => void;
  onCreateRepo: (data: { url: string; slug: string; default_branch: string }) => void;
  onCreateLocalRepo: (data: { path: string; slug?: string }) => void;
  onCreateAssistant: (result: AssistantTabResult) => void;
}

export const CreateDialog: React.FC<CreateDialogProps> = ({
  open,
  onClose,
  repoById,
  boardById,
  currentBoardId,
  defaultPosition,
  defaultTab = 'worktree',
  onCreateWorktree,
  onCreateBoard,
  onCreateRepo,
  onCreateLocalRepo,
  onCreateAssistant,
}) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>(defaultTab);
  const [isValid, setIsValid] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form submit refs — each tab exposes a submit function
  const worktreeFormRef = useRef<(() => Promise<WorktreeTabConfig | null>) | null>(null);
  const boardFormRef = useRef<(() => Promise<Partial<Board> | null>) | null>(null);
  const repoFormRef = useRef<(() => Promise<RepoTabResult | null>) | null>(null);
  const assistantFormRef = useRef<(() => Promise<AssistantTabResult | null>) | null>(null);

  // Reset state when dialog closes (covers both cancel and successful submit)
  useEffect(() => {
    if (!open) {
      setIsValid(false);
      setActiveTab(defaultTab);
    }
  }, [open, defaultTab]);

  const handleValidityChange = useCallback((valid: boolean) => {
    setIsValid(valid);
  }, []);

  const handleTabChange = (key: string) => {
    setActiveTab(key as ActiveTab);
    setIsValid(false);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      switch (activeTab) {
        case 'worktree': {
          const config = await worktreeFormRef.current?.();
          if (config) {
            onCreateWorktree(config);
            onClose();
          }
          break;
        }
        case 'board': {
          const board = await boardFormRef.current?.();
          if (board) {
            onCreateBoard(board);
            onClose();
          }
          break;
        }
        case 'repository': {
          const result = await repoFormRef.current?.();
          if (result) {
            if (result.mode === 'local' && result.local) {
              onCreateLocalRepo(result.local);
            } else if (result.remote) {
              onCreateRepo(result.remote);
            }
            onClose();
          }
          break;
        }
        case 'assistant': {
          const result = await assistantFormRef.current?.();
          if (result) {
            onCreateAssistant(result);
            onClose();
          }
          break;
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    onClose();
  };

  const tabItems = [
    {
      key: 'worktree',
      label: (
        <span>
          <BranchesOutlined style={{ marginRight: 8 }} />
          Worktree
        </span>
      ),
      children: (
        <div>
          <Alert
            type="info"
            showIcon
            description={PURPOSE_TEXT.worktree}
            style={{ marginBottom: 16 }}
          />
          <WorktreeTab
            repoById={repoById}
            currentBoardId={currentBoardId}
            defaultPosition={defaultPosition}
            onValidityChange={handleValidityChange}
            formRef={worktreeFormRef}
          />
        </div>
      ),
    },
    {
      key: 'assistant',
      label: (
        <span>
          <RobotOutlined style={{ marginRight: 8 }} />
          Assistant
        </span>
      ),
      children: (
        <div>
          <Alert
            type="info"
            showIcon
            description={PURPOSE_TEXT.assistant}
            style={{ marginBottom: 16 }}
          />
          <AssistantTab
            repoById={repoById}
            boardById={boardById}
            onValidityChange={handleValidityChange}
            formRef={assistantFormRef}
          />
        </div>
      ),
    },
    {
      key: 'board',
      label: (
        <span>
          <AppstoreOutlined style={{ marginRight: 8 }} />
          Board
        </span>
      ),
      children: (
        <div>
          <Alert
            type="info"
            showIcon
            description={PURPOSE_TEXT.board}
            style={{ marginBottom: 16 }}
          />
          <BoardTab onValidityChange={handleValidityChange} formRef={boardFormRef} />
        </div>
      ),
    },
    {
      key: 'repository',
      label: (
        <span>
          <FolderOutlined style={{ marginRight: 8 }} />
          Repository
        </span>
      ),
      children: (
        <div>
          <Alert
            type="info"
            showIcon
            description={PURPOSE_TEXT.repository}
            style={{ marginBottom: 16 }}
          />
          <RepoTab onValidityChange={handleValidityChange} formRef={repoFormRef} />
        </div>
      ),
    },
  ];

  return (
    <Modal
      title="Create New..."
      open={open}
      onCancel={handleCancel}
      destroyOnClose
      width={720}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          Cancel
        </Button>,
        <Button
          key="create"
          type="primary"
          onClick={handleSubmit}
          disabled={!isValid}
          loading={isSubmitting}
        >
          {ACTION_LABELS[activeTab]}
        </Button>,
      ]}
      styles={{
        body: { padding: '8px 0 0' },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={tabItems}
        style={{ minHeight: 360 }}
      />
    </Modal>
  );
};
