import type { MCPServer, Repo, Session, User, Worktree } from '@agor-live/client';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';

/**
 * App data is split into granular contexts so that high-frequency mutations
 * (sessions / worktrees) don't force re-renders of consumers that only
 * care about slow-moving entity data, and slow-moving entity updates don't
 * invalidate unrelated entity consumers.
 *
 * Before the split, a single `session:patched` event would mutate
 * `sessionById`, change the merged `appDataValue` reference, and cascade
 * a re-render through every `useAppData()` consumer — including
 * SessionPanel, which doesn't read sessions/worktrees from context at all.
 * With the split, SessionPanel subscribes only to the specific entity
 * contexts it needs and is insulated from streaming-driven session churn.
 *
 * - **AppRepoDataContext**: repositories (rarely changes).
 * - **AppUserDataContext**: users (registration / profile edits).
 * - **AppMcpDataContext**: MCP servers + per-user OAuth status.
 * - **AppLiveDataContext**: high-frequency, socket-driven changes
 *   (sessions, worktrees).
 *
 * Other live slices (boards/board-objects/comments, session-MCP links,
 * cards, ...) are still threaded through props from the outer App.
 * They're added here when an actual consumer needs them — kept tight on
 * purpose so this file stays an honest description of what each context
 * exposes (per code review feedback: don't ship unused fields).
 */

export interface AppRepoDataContextValue {
  // Repositories (config-level, rarely changes)
  repoById: Map<string, Repo>;
}

export interface AppUserDataContextValue {
  // Users (rarely changes — registration / profile edits)
  userById: Map<string, User>;
}

export interface AppMcpDataContextValue {
  // MCP servers + per-user auth state (admin / OAuth flows)
  mcpServerById: Map<string, MCPServer>;
  userAuthenticatedMcpServerIds: Set<string>; // MCP server IDs where current user has valid per-user OAuth tokens
}

export interface AppEntityDataContextValue
  extends AppRepoDataContextValue,
    AppUserDataContextValue,
    AppMcpDataContextValue {}

export interface AppLiveDataContextValue {
  // Sessions and worktrees — patched on every status flip / activity tick
  sessionById: Map<string, Session>;
  worktreeById: Map<string, Worktree>;
  sessionsByWorktree: Map<string, Session[]>; // Indexed for quick filtering
}

const AppRepoDataContext = createContext<AppRepoDataContextValue | undefined>(undefined);
const AppUserDataContext = createContext<AppUserDataContextValue | undefined>(undefined);
const AppMcpDataContext = createContext<AppMcpDataContextValue | undefined>(undefined);
const AppLiveDataContext = createContext<AppLiveDataContextValue | undefined>(undefined);

interface AppRepoDataProviderProps {
  children: React.ReactNode;
  value: AppRepoDataContextValue;
}

interface AppUserDataProviderProps {
  children: React.ReactNode;
  value: AppUserDataContextValue;
}

interface AppMcpDataProviderProps {
  children: React.ReactNode;
  value: AppMcpDataContextValue;
}

interface AppEntityDataProviderProps {
  children: React.ReactNode;
  value: AppEntityDataContextValue;
}

interface AppLiveDataProviderProps {
  children: React.ReactNode;
  value: AppLiveDataContextValue;
}

export const AppRepoDataProvider: React.FC<AppRepoDataProviderProps> = ({ children, value }) => {
  return <AppRepoDataContext.Provider value={value}>{children}</AppRepoDataContext.Provider>;
};

export const AppUserDataProvider: React.FC<AppUserDataProviderProps> = ({ children, value }) => {
  return <AppUserDataContext.Provider value={value}>{children}</AppUserDataContext.Provider>;
};

export const AppMcpDataProvider: React.FC<AppMcpDataProviderProps> = ({ children, value }) => {
  return <AppMcpDataContext.Provider value={value}>{children}</AppMcpDataContext.Provider>;
};

export const AppLiveDataProvider: React.FC<AppLiveDataProviderProps> = ({ children, value }) => {
  return <AppLiveDataContext.Provider value={value}>{children}</AppLiveDataContext.Provider>;
};

/**
 * Back-compat composite provider used by App.tsx. It accepts the same combined
 * value shape the old entity provider used, then fans it out into narrower
 * providers with separately memoized values so an update to one entity family
 * does not notify consumers of the others.
 */
export const AppEntityDataProvider: React.FC<AppEntityDataProviderProps> = ({
  children,
  value,
}) => {
  const repoValue = useMemo(() => ({ repoById: value.repoById }), [value.repoById]);
  const userValue = useMemo(() => ({ userById: value.userById }), [value.userById]);
  const mcpValue = useMemo(
    () => ({
      mcpServerById: value.mcpServerById,
      userAuthenticatedMcpServerIds: value.userAuthenticatedMcpServerIds,
    }),
    [value.mcpServerById, value.userAuthenticatedMcpServerIds]
  );

  return (
    <AppRepoDataProvider value={repoValue}>
      <AppUserDataProvider value={userValue}>
        <AppMcpDataProvider value={mcpValue}>{children}</AppMcpDataProvider>
      </AppUserDataProvider>
    </AppRepoDataProvider>
  );
};

/**
 * Repo data (rarely changes). Subscribing to this hook does NOT trigger
 * re-renders when users, MCP servers, sessions, worktrees, or boards mutate.
 */
export const useAppRepoData = (): AppRepoDataContextValue => {
  const context = useContext(AppRepoDataContext);
  if (!context) {
    throw new Error('useAppRepoData must be used within an AppRepoDataProvider');
  }
  return context;
};

/**
 * User data (registration / profile edits). Subscribing to this hook does NOT
 * trigger re-renders when repos, MCP servers, sessions, worktrees, or boards mutate.
 */
export const useAppUserData = (): AppUserDataContextValue => {
  const context = useContext(AppUserDataContext);
  if (!context) {
    throw new Error('useAppUserData must be used within an AppUserDataProvider');
  }
  return context;
};

/**
 * MCP server data + per-user OAuth status. Subscribing to this hook does NOT
 * trigger re-renders when users, repos, sessions, worktrees, or boards mutate.
 */
export const useAppMcpData = (): AppMcpDataContextValue => {
  const context = useContext(AppMcpDataContext);
  if (!context) {
    throw new Error('useAppMcpData must be used within an AppMcpDataProvider');
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
