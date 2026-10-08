import type { AgorClient, Board, Branch, User } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import type { BranchUpdate } from '../components/BranchModal/tabs/GeneralTab';
import type { CreateDialogProgress } from '../components/CreateDialog';
import type { BranchTabConfig } from '../components/CreateDialog/tabs/BranchTab';
import type { TeammateTabResult } from '../components/CreateDialog/tabs/TeammateTab';
import type { NewSessionConfig, SessionCreationResult } from '../domain/sessionCreation';
import { agorStore } from '../store/agorStore';
import { useThemedMessage } from '../utils/message';
import { startTeammateBootstrapSession } from '../utils/startTeammateBootstrapSession';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateFirstSessionTitle,
} from '../utils/teammateBootstrapPrompt';
import { createTeammateBranch } from '../utils/teammateCreation';

export type CreateBranchHandler = (
  repoId: string,
  data: {
    name: string;
    ref: string;
    refType?: 'branch' | 'tag';
    createBranch: boolean;
    sourceBranch?: string;
    sourceRemoteUrl?: string;
    pullLatest: boolean;
    issue_url?: string;
    pull_request_url?: string;
    boardId?: string;
    custom_context?: Record<string, unknown>;
    notes?: string | null;
    position?: { x: number; y: number };
    storage_mode?: 'worktree' | 'clone';
    clone_depth?: number;
  }
) => Promise<Branch | null>;

interface UseCreateFlowsOptions {
  client: AgorClient | null;
  user?: User | null;
  currentBoardId?: string;
  /** Board a new teammate joins as primary; unset creates a fresh board. */
  teammateTargetBoardId?: string | null;
  /** Where each shell lands the user after a create. */
  navigation: {
    goToBranch: (branchId: string) => void;
    goToBoard: (boardId: string) => void;
    goToSession: (sessionId: string) => void;
  };
  onCreateBranch?: CreateBranchHandler;
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void | Promise<void>;
  onCreateBoard?: (board: Partial<Board>) => Promise<Board | null>;
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
}

/** CreateDialog submit handlers, shared by the desktop and mobile shells. */
export function useCreateFlows({
  client,
  user,
  currentBoardId,
  teammateTargetBoardId,
  navigation,
  onCreateBranch,
  onUpdateBranch,
  onCreateBoard,
  onCreateSession,
}: UseCreateFlowsOptions) {
  const { showWarning } = useThemedMessage();

  const createBranch = async (config: BranchTabConfig) => {
    // Board placement (boardId + position) goes in the create call so it lands atomically.
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
    // The branch may not be in the store yet; the route resolves it once it arrives.
    if (branch) navigation.goToBranch(branch.branch_id);
  };

  const createBoard = async (board: Partial<Board>) => {
    if (!onCreateBoard) return;
    const created = await onCreateBoard(board);
    if (created?.board_id) navigation.goToBoard(created.board_id);
  };

  const createTeammate = async (result: TeammateTabResult, progress?: CreateDialogProgress) => {
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
        ...(teammateTargetBoardId
          ? {
              boardId: teammateTargetBoardId,
              keepExistingPrimary: true,
              // An existing board with branches already has its own layout; skip the welcome note.
              welcomeNote: ![...agorStore.getState().branchById.values()].some(
                (branch) => branch.board_id === teammateTargetBoardId
              ),
            }
          : {}),
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
        userName: user?.name,
        userEmail: user?.email,
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
      codexIncludePlugins: result.codexIncludePlugins,
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

    // Keep the created teammate reachable; the create-session handler already toasted the failure.
    progress?.onStatusChange?.('Opening AI teammate branch…');
    navigation.goToBranch(branch.branch_id);
  };

  return { createBranch, createBoard, createTeammate };
}
