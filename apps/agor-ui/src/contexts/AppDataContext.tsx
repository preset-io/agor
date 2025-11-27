import type {
  Board,
  BoardComment,
  BoardEntityObject,
  MCPServer,
  Repo,
  Session,
  User,
  Worktree,
} from '@agor/core/types';
import type React from 'react';
import { createContext, useContext } from 'react';

/**
 * AppDataContext - Provides read-only access to all application data maps
 *
 * This context eliminates prop drilling for data lookups across the component tree.
 * All maps are keyed by their respective entity IDs for O(1) lookups.
 */
export interface AppDataContextValue {
  // Sessions and worktrees
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
  sessionsByWorktree: Map<string, Session[]>; // Indexed for quick filtering

  // Repositories and MCP servers
  repoById: Map<string, Repo>;
  mcpServerById: Map<string, MCPServer>;
  sessionMcpServerIds: Map<string, string[]>; // Session ID -> MCP server IDs

  // Users
  userById: Map<string, User>;

  // Boards and spatial objects
  boardById: Map<string, Board>;
  boardObjectById: Map<string, BoardEntityObject>;
  commentById: Map<string, BoardComment>;
}

const AppDataContext = createContext<AppDataContextValue | undefined>(undefined);

interface AppDataProviderProps {
  children: React.ReactNode;
  value: AppDataContextValue;
}

export const AppDataProvider: React.FC<AppDataProviderProps> = ({ children, value }) => {
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
};

/**
 * Hook to access application data maps
 *
 * @throws Error if used outside of AppDataProvider
 *
 * @example
 * const { sessionById, userById, repoById } = useAppData();
 * const session = sessionById.get(sessionId);
 * const user = userById.get(session.created_by);
 */
export const useAppData = (): AppDataContextValue => {
  const context = useContext(AppDataContext);
  if (!context) {
    throw new Error('useAppData must be used within an AppDataProvider');
  }
  return context;
};
