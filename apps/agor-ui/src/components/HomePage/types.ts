import type { KnowledgeDocument as CoreKnowledgeDocument } from '@agor/core/types';
import type { AgorClient, Board, Branch, MCPServer, Repo, Session, User } from '@agor-live/client';

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

/**
 * Entity maps the home sub-sections consume. HomePage reads these from the
 * store and drills them into its sections, so they're typed separately from
 * HomePageProps (which carries only HomePage's own props).
 */
export interface HomeEntityMaps {
  boardById: Map<string, Board>;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionById: Map<string, Session>;
  sessionsByBranch: Map<string, Session[]>;
  userById: Map<string, User>;
  mcpServerById?: Map<string, MCPServer>;
}

/** Props available to home sub-sections: HomePage's own props plus entity maps. */
export type HomeSectionProps = HomePageProps & HomeEntityMaps;

export interface KnowledgeDocument
  extends Omit<CoreKnowledgeDocument, 'created_at' | 'updated_at' | 'archived_at'> {
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  archived_at?: string | Date | null;
}
