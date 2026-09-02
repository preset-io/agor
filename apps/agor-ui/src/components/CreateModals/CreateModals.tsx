import type {
  AgorClient,
  Board,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  User,
} from '@agor-live/client';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import type { AgenticToolOption } from '../../types';
import type { BranchTabConfig } from '../CreateDialog/tabs/BranchTab';
import type { TeammateTabResult } from '../CreateDialog/tabs/TeammateTab';
import type { CreateModalKind } from '../CreateMenu';
import { CreateBoardModal } from './CreateBoardModal';
import { CreateBranchModal } from './CreateBranchModal';
import { CreateRepoModal } from './CreateRepoModal';
import { CreateTeammateModal, type TeammateProgress } from './CreateTeammateModal';

export interface CreateModalsProps {
  /** Which focused modal is open, or null when all are closed. */
  active: CreateModalKind | null;
  onClose: () => void;
  currentBoardId?: string;
  defaultPosition?: { x: number; y: number };
  availableAgents: AgenticToolOption[];
  currentUser?: User | null;
  client?: AgorClient | null;
  onCreateBranch: (config: BranchTabConfig) => void | Promise<void>;
  onCreateBoard: (board: Partial<Board>) => void | Promise<void>;
  onCreateRepo: (data: CreateRepoRequest) => unknown;
  onCreateLocalRepo: (data: CreateLocalRepoRequest) => void | Promise<void>;
  onCreateTeammate?: (
    result: TeammateTabResult,
    progress?: TeammateProgress
  ) => void | Promise<void>;
  branchStorageConfig?: BranchStorageConfig;
}

/**
 * Renders the four single-purpose create modals and shows whichever one
 * `active` names. Replaces the old tabbed CreateDialog; each modal keeps its own
 * form and submit flow so nothing else has to know which one is open.
 */
export const CreateModals: React.FC<CreateModalsProps> = ({
  active,
  onClose,
  currentBoardId,
  defaultPosition,
  availableAgents,
  currentUser,
  client,
  onCreateBranch,
  onCreateBoard,
  onCreateRepo,
  onCreateLocalRepo,
  onCreateTeammate,
  branchStorageConfig,
}) => (
  <>
    <CreateTeammateModal
      open={active === 'teammate'}
      onClose={onClose}
      availableAgents={availableAgents}
      currentUser={currentUser}
      client={client}
      onCreateRepo={onCreateRepo}
      onCreateTeammate={onCreateTeammate}
    />
    <CreateBranchModal
      open={active === 'branch'}
      onClose={onClose}
      currentBoardId={currentBoardId}
      defaultPosition={defaultPosition}
      onCreateBranch={onCreateBranch}
      branchStorageConfig={branchStorageConfig}
    />
    <CreateBoardModal open={active === 'board'} onClose={onClose} onCreateBoard={onCreateBoard} />
    <CreateRepoModal
      open={active === 'repository'}
      onClose={onClose}
      onCreateRepo={onCreateRepo}
      onCreateLocalRepo={onCreateLocalRepo}
    />
  </>
);
