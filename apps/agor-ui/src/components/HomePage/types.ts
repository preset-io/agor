import type { KnowledgeDocument as CoreKnowledgeDocument } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';

export interface HomePageProps {
  client: AgorClient | null;
  connected?: boolean;
  recentBoardIds?: string[];
  currentUserId?: string;
  onBoardClick: (boardId: string) => void;
  onBranchClick: (branchId: string) => void;
  onSessionClick: (sessionId: string) => void;
  onOpenCreateDialog: (
    tab: 'assistant' | 'branch' | 'board' | 'repository',
    boardId?: string
  ) => void;
  onOpenSettings: (section: 'repos' | 'mcp' | 'users') => void;
}

export interface KnowledgeDocument
  extends Omit<CoreKnowledgeDocument, 'created_at' | 'updated_at' | 'archived_at'> {
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  archived_at?: string | Date | null;
}
