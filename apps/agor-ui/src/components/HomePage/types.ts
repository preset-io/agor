import type { KnowledgeDocument as CoreKnowledgeDocument } from '@agor/core/types';
import type {
  AgorClient,
  Board,
  Branch,
  InitialSessionSummary,
  Repo,
  User,
} from '@agor-live/client';

export interface HomePageProps {
  client: AgorClient | null;
  connected?: boolean;
  boardById: Map<string, Board>;
  recentBoardIds?: string[];
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionById: Map<string, InitialSessionSummary>;
  sessionsByBranch: Map<string, InitialSessionSummary[]>;
  userById: Map<string, User>;
  currentUserId?: string;
  onBoardClick: (boardId: string) => void;
  onBranchClick: (branchId: string) => void;
  onSessionClick: (sessionId: string) => void;
}

export interface KnowledgeDocument
  extends Omit<CoreKnowledgeDocument, 'created_at' | 'updated_at' | 'archived_at'> {
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  archived_at?: string | Date | null;
}
