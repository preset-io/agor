import type {
  AgorClient,
  Board,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  MCPServer,
  Repo,
  User,
} from '@agor-live/client';
import {
  AppstoreOutlined,
  BranchesOutlined,
  FolderOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Alert, Button, Modal, Tabs } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgenticToolOption } from '../../types';
import type { AssistantTabResult } from './tabs/AssistantTab';
import { AssistantTab } from './tabs/AssistantTab';
import { BoardTab } from './tabs/BoardTab';
import type { BranchTabConfig } from './tabs/BranchTab';
import { BranchTab } from './tabs/BranchTab';
import type { RepoTabResult } from './tabs/RepoTab';
import { RepoTab } from './tabs/RepoTab';

type ActiveTab = 'branch' | 'assistant' | 'board' | 'repository';

export interface CreateDialogProgress {
  onStatusChange?: (status: string) => void;
}

const INITIAL_VALIDITY: Record<ActiveTab, boolean> = {
  branch: false,
  assistant: false,
  board: false,
  repository: false,
};

const PURPOSE_TEXT: Record<ActiveTab, React.ReactNode> = {
  branch: (
    <>
      A branch (built on{' '}
      <a href="https://git-scm.com/docs/git-branch" target="_blank" rel="noopener noreferrer">
        git branches
      </a>
      ) is essentially a place in the filesystem representing an isolated development branch. This
      is where one or more coding sessions take place. In Agor, they're generally ephemeral and
      follow the lifecycle of a given feature.
    </>
  ),
  assistant:
    'Assistants are long-lived agents with an identity, purpose, and goals. Think of them like employees. They have memory, can build their own skills, coordinate multiple coding agents, typically operate on their own Agor board, and can act proactively.',
  board:
    'Boards are spatial canvases for organizing work. They contain branches, zones, cards, and other visual elements. Use boards to create workspaces for teams, projects, or assistants.',
  repository:
    'Repositories connect your code to Agor. They can be cloned from GitHub or registered from a local path. Once connected, you can create branches for coding tasks.',
};

const ACTION_LABELS: Record<ActiveTab, string> = {
  branch: 'Create Branch',
  assistant: 'Create Assistant',
  board: 'Create Board',
  repository: 'Add Repository',
};

export interface CreateDialogProps {
  open: boolean;
  onClose: () => void;
  repoById: Map<string, Repo>;
  currentBoardId?: string;
  defaultPosition?: { x: number; y: number };
  availableAgents: AgenticToolOption[];
  mcpServerById?: Map<string, MCPServer>;
  currentUser?: User | null;
  client?: AgorClient | null;
  defaultTab?: ActiveTab;
  onCreateBranch: (config: BranchTabConfig) => void | Promise<void>;
  onCreateBoard: (board: Partial<Board>) => void | Promise<void>;
  onCreateRepo: (data: CreateRepoRequest) => void | Promise<void>;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
  onCreateAssistant: (
    result: AssistantTabResult,
    progress?: CreateDialogProgress
  ) => void | Promise<void>;
}

/** Fire the parent handler and close the dialog. We don't `await` here
 *  because the parent may navigate (away from the dialog's host
 *  component) as part of its work — blocking the close on that would
 *  delay the modal teardown. Rejections are swallowed: each parent
 *  handler already surfaces its own errors via toasts. */
function fireAndForget(result: void | Promise<void>) {
  Promise.resolve(result).catch(() => {});
}

export const CreateDialog: React.FC<CreateDialogProps> = ({
  open,
  onClose,
  repoById,
  currentBoardId,
  defaultPosition,
  availableAgents,
  mcpServerById,
  currentUser,
  client,
  defaultTab = 'assistant',
  onCreateBranch,
  onCreateBoard,
  onCreateRepo,
  onCreateLocalRepo,
  onCreateAssistant,
}) => {
  const [activeTab, setActiveTab] = useState<ActiveTab>(defaultTab);
  // Validity is tracked per tab so a sibling tab's empty-form state (or a
  // deferred validity push from its init effect) can't clobber the active
  // tab's submit button.
  const [validByTab, setValidByTab] = useState<Record<ActiveTab, boolean>>(INITIAL_VALIDITY);
  const isValid = validByTab[activeTab];
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Form submit refs — each tab exposes a submit function
  const branchFormRef = useRef<(() => Promise<BranchTabConfig | null>) | null>(null);
  const boardFormRef = useRef<(() => Promise<Partial<Board> | null>) | null>(null);
  const repoFormRef = useRef<(() => Promise<RepoTabResult | null>) | null>(null);
  const assistantFormRef = useRef<(() => Promise<AssistantTabResult | null>) | null>(null);

  // Reset state when dialog closes (covers both cancel and successful submit)
  useEffect(() => {
    if (!open) {
      setValidByTab(INITIAL_VALIDITY);
      setActiveTab(defaultTab);
      setIsSubmitting(false);
      setSubmitStatus(null);
      setSubmitError(null);
    }
  }, [open, defaultTab]);

  const setTabValid = useCallback((tab: ActiveTab, valid: boolean) => {
    setValidByTab((prev) => (prev[tab] === valid ? prev : { ...prev, [tab]: valid }));
  }, []);

  const handleBranchValid = useCallback((v: boolean) => setTabValid('branch', v), [setTabValid]);
  const handleAssistantValid = useCallback(
    (v: boolean) => setTabValid('assistant', v),
    [setTabValid]
  );
  const handleBoardValid = useCallback((v: boolean) => setTabValid('board', v), [setTabValid]);
  const handleRepositoryValid = useCallback(
    (v: boolean) => setTabValid('repository', v),
    [setTabValid]
  );

  const handleTabChange = (key: string) => {
    setActiveTab(key as ActiveTab);
    setSubmitError(null);
    setSubmitStatus(null);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitStatus(null);

    try {
      switch (activeTab) {
        case 'branch': {
          const config = await branchFormRef.current?.();
          if (config) {
            fireAndForget(onCreateBranch(config));
            onClose();
          }
          break;
        }
        case 'board': {
          const board = await boardFormRef.current?.();
          if (board) {
            fireAndForget(onCreateBoard(board));
            onClose();
          }
          break;
        }
        case 'repository': {
          const result = await repoFormRef.current?.();
          if (result) {
            if (result.mode === 'local' && result.local) {
              fireAndForget(onCreateLocalRepo(result.local));
            } else if (result.remote) {
              fireAndForget(onCreateRepo(result.remote));
            }
            onClose();
          }
          break;
        }
        case 'assistant': {
          const result = await assistantFormRef.current?.();
          if (result) {
            setSubmitStatus('Creating assistant…');
            await onCreateAssistant(result, { onStatusChange: setSubmitStatus });
            onClose();
          }
          break;
        }
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (isSubmitting) return;
    onClose();
  };

  const tabItems = [
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
            onValidityChange={handleAssistantValid}
            formRef={assistantFormRef}
            onCreateRepo={onCreateRepo}
            availableAgents={availableAgents}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
          />
        </div>
      ),
    },
    {
      key: 'branch',
      label: (
        <span>
          <BranchesOutlined style={{ marginRight: 8 }} />
          Branch
        </span>
      ),
      children: (
        <div>
          <Alert
            type="info"
            showIcon
            description={PURPOSE_TEXT.branch}
            style={{ marginBottom: 16 }}
          />
          <BranchTab
            repoById={repoById}
            currentBoardId={currentBoardId}
            defaultPosition={defaultPosition}
            onValidityChange={handleBranchValid}
            formRef={branchFormRef}
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
          <BoardTab onValidityChange={handleBoardValid} formRef={boardFormRef} />
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
          <RepoTab onValidityChange={handleRepositoryValid} formRef={repoFormRef} />
        </div>
      ),
    },
  ];

  return (
    <Modal
      title="Create New..."
      open={open}
      onCancel={handleCancel}
      destroyOnHidden
      width={720}
      closable={!isSubmitting}
      maskClosable={!isSubmitting}
      keyboard={!isSubmitting}
      footer={[
        <Button key="cancel" onClick={handleCancel} disabled={isSubmitting}>
          Cancel
        </Button>,
        <Button
          key="create"
          type="primary"
          onClick={handleSubmit}
          disabled={!isValid}
          loading={isSubmitting}
        >
          {isSubmitting && submitStatus ? submitStatus : ACTION_LABELS[activeTab]}
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
      {submitError && (
        <Alert
          type="error"
          showIcon
          message="Couldn't finish creating this item"
          description={submitError}
          style={{ marginTop: 16 }}
        />
      )}
    </Modal>
  );
};
