import type {
  AgorClient,
  Board,
  Branch,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  User,
} from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { useCallback, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import type { BranchUpdate } from '../components/BranchModal/useBranchModalForm';
import type { BranchTabConfig } from '../components/CreateDialog/tabs/BranchTab';
import type { TeammateTabResult } from '../components/CreateDialog/tabs/TeammateTab';
import type { CreateModalKind } from '../components/CreateMenu';
import type { CreateModalsProps, TeammateProgress } from '../components/CreateModals';
import type { NewSessionConfig, SessionCreationResult } from '../domain/sessionCreation';
import { agorStore } from '../store/agorStore';
import type { AgenticToolOption } from '../types';
import { useThemedMessage } from '../utils/message';
import { startTeammateBootstrapSession } from '../utils/startTeammateBootstrapSession';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateFirstSessionTitle,
} from '../utils/teammateBootstrapPrompt';
import { createTeammateBranch } from '../utils/teammateCreation';

type Position = { x: number; y: number };

/** Where each create flow lands the user after success. Host-specific. */
export interface CreateFlowNavigation {
  goToBranch: (branchId: string) => void;
  goToBoard: (boardId: string) => void;
  goToSession: (sessionId: string) => void;
}

/** Raw branch-create seam (shared by desktop App and MobileApp). */
export type CreateBranchFn = (
  repoId: string,
  data: {
    name: string;
    ref: string;
    refType?: 'branch' | 'tag';
    createBranch: boolean;
    sourceBranch: string;
    sourceRemoteUrl?: string;
    pullLatest: boolean;
    issue_url?: string;
    pull_request_url?: string;
    boardId?: string;
    position?: Position;
    storage_mode?: 'worktree' | 'clone';
    clone_depth?: number;
  }
) => Promise<Branch | null>;

export interface UseCreateFlowsOptions {
  client: AgorClient | null;
  currentUser?: User | null;
  currentBoardId?: string;
  availableAgents: AgenticToolOption[];
  branchStorageConfig?: BranchStorageConfig;
  navigation: CreateFlowNavigation;
  onCreateBranch?: CreateBranchFn;
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void | Promise<void>;
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  onCreateBoard?: (board: Partial<Board>) => Promise<Board | null>;
  onCreateRepo: (data: CreateRepoRequest) => unknown;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
  /** Board viewport position captured when a flow opens (desktop canvas only). */
  getDefaultPosition?: () => Position | null | undefined;
}

export interface UseCreateFlowsResult {
  activeCreateModal: CreateModalKind | null;
  openCreate: (kind: CreateModalKind) => void;
  closeCreate: () => void;
  /** Spread into a single shared <CreateModals /> (add `fullScreen` on mobile). */
  createModalsProps: CreateModalsProps;
}

/**
 * Single implementation of the four create flows (teammate incl. bootstrap
 * session, branch, board, repo) plus the open/close state behind the shared
 * CreateModals. Desktop App and MobileApp both consume this so the logic can't
 * drift; each passes its own navigation and raw create seams.
 */
export function useCreateFlows(options: UseCreateFlowsOptions): UseCreateFlowsResult {
  const {
    client,
    currentUser,
    currentBoardId,
    availableAgents,
    branchStorageConfig,
    navigation,
    onCreateBranch,
    onUpdateBranch,
    onCreateSession,
    onCreateBoard,
    onCreateRepo,
    onCreateLocalRepo,
    getDefaultPosition,
  } = options;

  const { showWarning } = useThemedMessage();
  const [activeCreateModal, setActiveCreateModal] = useState<CreateModalKind | null>(null);
  const [defaultPosition, setDefaultPosition] = useState<Position | null>(null);

  const openCreate = useCallback(
    (kind: CreateModalKind) => {
      setDefaultPosition(getDefaultPosition?.() ?? null);
      setActiveCreateModal(kind);
    },
    [getDefaultPosition]
  );

  const closeCreate = useCallback(() => {
    setActiveCreateModal(null);
    setDefaultPosition(null);
  }, []);

  const handleCreateBranch = async (config: BranchTabConfig) => {
    const branch = await onCreateBranch?.(config.repoId, {
      name: config.name,
      ref: config.ref,
      refType: config.refType,
      createBranch: config.createBranch,
      sourceBranch: config.sourceBranch,
      pullLatest: config.pullLatest,
      issue_url: config.issue_url,
      pull_request_url: config.pull_request_url,
      ...(config.board_id ? { boardId: config.board_id } : {}),
      ...(config.position ? { position: config.position } : {}),
      ...(config.storage_mode ? { storage_mode: config.storage_mode } : {}),
      ...(config.clone_depth !== undefined ? { clone_depth: config.clone_depth } : {}),
    });
    if (branch) {
      navigation.goToBranch(branch.branch_id);
    }
  };

  const handleCreateBoard = async (board: Partial<Board>) => {
    if (!onCreateBoard) return;
    const created = await onCreateBoard(board);
    if (created?.board_id) {
      navigation.goToBoard(created.board_id);
    }
  };

  const handleCreateTeammate = async (result: TeammateTabResult, progress?: TeammateProgress) => {
    const repoId = result.repoId;
    if (!repoId || !onCreateBranch || !onUpdateBranch) {
      throw new Error('Missing repository or branch creation handler for AI teammate creation.');
    }

    progress?.onStatusChange?.('Creating AI teammate branch…');

    const branch = await createTeammateBranch(
      {
        displayName: result.displayName,
        description: result.description,
        emoji: result.emoji,
        repoId,
        branchName: result.branchName,
        sourceBranch: result.sourceBranch,
        sourceRemoteUrl: result.sourceRemoteUrl,
      },
      { client, repoById: agorStore.getState().repoById, onCreateBranch, onUpdateBranch }
    );

    if (!branch) {
      throw new Error(
        'AI teammate branch could not be created. Please check the branch details and try again.'
      );
    }

    const sessionConfig: NewSessionConfig = {
      branch_id: branch.branch_id,
      agent: result.agent,
      agenticToolPresetId: result.agenticToolPresetId,
      title: buildTeammateFirstSessionTitle(result),
      initialPrompt: buildTeammateBootstrapPrompt({
        displayName: result.displayName,
        emoji: result.emoji,
        description: result.description,
        userName: currentUser?.name,
        userEmail: currentUser?.email,
        templateId: result.templateId,
        localHome: getTeammateConfig(branch)?.localHome,
      }),
      modelConfig: result.modelConfig,
      effort: result.effort,
      mcpServerIds: result.mcpServerIds,
      permissionMode: result.permissionMode,
      codexSandboxMode: result.codexSandboxMode,
      codexApprovalPolicy: result.codexApprovalPolicy,
      codexNetworkAccess: result.codexNetworkAccess,
    };

    try {
      if (!onCreateSession) {
        throw new Error('Missing session creation handler.');
      }
      const initialization = await startTeammateBootstrapSession({
        client,
        branchId: branch.branch_id,
        boardId: branch.board_id || currentBoardId || '',
        sessionConfig,
        onCreateSession,
        onStatusChange: progress?.onStatusChange,
      });
      navigation.goToSession(initialization.sessionId);
      return;
    } catch (error) {
      console.error('AI teammate session bootstrap failed:', error);
      showWarning(
        `AI teammate branch was created, but the first session could not start: ${
          error instanceof Error ? error.message : String(error)
        }. Opening the branch instead.`,
        { key: 'teammate-bootstrap-session', duration: 8 }
      );
    }

    progress?.onStatusChange?.('Opening AI teammate branch…');
    navigation.goToBranch(branch.branch_id);
  };

  return {
    activeCreateModal,
    openCreate,
    closeCreate,
    createModalsProps: {
      active: activeCreateModal,
      onClose: closeCreate,
      currentBoardId,
      defaultPosition: defaultPosition || undefined,
      availableAgents,
      currentUser,
      client,
      onCreateBranch: handleCreateBranch,
      onCreateBoard: handleCreateBoard,
      onCreateRepo,
      onCreateLocalRepo,
      onCreateTeammate: handleCreateTeammate,
      branchStorageConfig,
    },
  };
}
