import type { MCPServer, Repo, Session, User, Worktree } from '@agor-live/client';
import type React from 'react';
import { createContext, useContext } from 'react';

/**
 * App data is split into TWO contexts so that high-frequency mutations
 * (sessions / worktrees) don't force re-renders of consumers that only
 * care about slow-moving entity data (users, repos, MCP servers, OAuth
 * status).
 *
 * Before the split, a single `session:patched` event would mutate
 * `sessionById`, change the merged `appDataValue` reference, and cascade
 * a re-render through every `useAppData()` consumer — including
 * SessionPanel, which doesn't read sessions/worktrees from context at all.
 * With the split, SessionPanel subscribes only to the entity context and
 * is insulated from streaming-driven session churn.
 *
 * - **AppEntityDataContext**: low-frequency, mostly user/admin-driven
 *   changes (users, repos, MCP servers).
 * - **AppLiveDataContext**: high-frequency, socket-driven changes
 *   (sessions, worktrees).
 *
 * Other live slices (boards/board-objects/comments, session-MCP links,
 * cards, ...) are still threaded through props from the outer App.
 * They're added here when an actual consumer needs them — kept tight on
 * purpose so this file stays an honest description of what each context
 * exposes (per code review feedback: don't ship unused fields).
 */

export interface AppEntityDataContextValue {
  // Repositories (config-level, rarely changes)
  repoById: Map<string, Repo>;

  // Users (rarely changes — registration / profile edits)
  userById: Map<string, User>;

  // MCP servers + per-user auth state (admin / OAuth flows)
  mcpServerById: Map<string, MCPServer>;
  userAuthenticatedMcpServerIds: Set<string>; // MCP server IDs where current user has valid per-user OAuth tokens
}

export interface AppLiveDataContextValue {
  // Sessions and worktrees — patched on every status flip / activity tick
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
  sessionsByWorktree: Map<string, Session[]>; // Indexed for quick filtering
}

const AppEntityDataContext = createContext<AppEntityDataContextValue | undefined>(undefined);
const AppLiveDataContext = createContext<AppLiveDataContextValue | undefined>(undefined);

interface AppEntityDataProviderProps {
  children: React.ReactNode;
  value: AppEntityDataContextValue;
}

interface AppLiveDataProviderProps {
  children: React.ReactNode;
  value: AppLiveDataContextValue;
}

export const AppEntityDataProvider: React.FC<AppEntityDataProviderProps> = ({
  children,
  value,
}) => {
  return <AppEntityDataContext.Provider value={value}>{children}</AppEntityDataContext.Provider>;
};

export const AppLiveDataProvider: React.FC<AppLiveDataProviderProps> = ({ children, value }) => {
  return <AppLiveDataContext.Provider value={value}>{children}</AppLiveDataContext.Provider>;
};

/**
 * Slow-moving entity data (users, repos, MCP). Subscribing to this hook
 * does NOT trigger re-renders when sessions / worktrees / boards mutate.
 */
export const useAppEntityData = (): AppEntityDataContextValue => {
  const context = useContext(AppEntityDataContext);
  if (!context) {
    throw new Error('useAppEntityData must be used within an AppEntityDataProvider');
  }
  return context;
};

/**
 * High-frequency live data (sessions, worktrees, boards). Subscribing to
 * this hook re-renders on every socket-driven mutation in those slices —
 * use only when you actually need to read live state.
 */
export const useAppLiveData = (): AppLiveDataContextValue => {
  const context = useContext(AppLiveDataContext);
  if (!context) {
    throw new Error('useAppLiveData must be used within an AppLiveDataProvider');
  }
  return context;
};
