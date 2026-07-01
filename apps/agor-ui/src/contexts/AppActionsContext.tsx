import type {
  AgenticToolName,
  PermissionMode,
  PermissionScope,
  Session,
  SpawnConfig,
} from '@agor-live/client';
import type React from 'react';
import { createContext, useContext } from 'react';
import type { AgenticToolOption } from '../components/AgentSelectionGrid/AgentSelectionGrid';
import type { BranchModalTab } from '../components/BranchModal/BranchModal';

/**
 * AppActionsContext - Provides action callbacks for domain operations
 *
 * This context eliminates prop drilling for callbacks across the component tree.
 * All callbacks should be memoized with useCallback in the provider.
 */
export interface AppActionsContextValue {
  // Session actions
  onSendPrompt?: (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode
  ) => boolean | undefined | Promise<boolean | undefined>;
  onFork?: (sessionId: string, prompt: string) => Promise<void>;
  onBtwFork?: (sessionId: string, prompt: string) => Promise<void>;
  onSubsession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSession?: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession?: (sessionId: string) => void;
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;

  // Branch/Environment actions
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;

  // Navigation/UI actions
  onOpenSettings?: (sessionId: string) => void;
  /** Open / select a session by id (cross-board navigation when needed). */
  onSessionClick?: (sessionId: string) => void;
  onOpenBranch?: (branchId: string, tab?: BranchModalTab) => void;
  onOpenTerminal?: (commands: string[], branchId?: string) => void;
  /** Open Settings deep-linked to a specific Agentic Tools provider tab. */
  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;

  /**
   * Single mechanism behind both tool-choice entry points: the quick-start
   * empty-state tiles (no `replacingSessionId` — nothing to replace yet)
   * and the in-drawer "Switch tool" affordance (`replacingSessionId` set to
   * the current, never-prompted session, which gets silently swapped out).
   * Creates a session with `tool`, navigates to it, and resolves the new
   * session id (or `null` on failure). Does NOT remember the choice as a
   * default — every "Add session" always shows the tile picker.
   */
  onChooseAgenticTool?: (
    branchId: string,
    tool: AgenticToolName,
    replacingSessionId?: string
  ) => Promise<string | null>;
  /** Tools available for the quick-start tile picker / tool switcher. */
  availableAgents?: AgenticToolOption[];
}

const AppActionsContext = createContext<AppActionsContextValue | undefined>(undefined);

interface AppActionsProviderProps {
  children: React.ReactNode;
  value: AppActionsContextValue;
}

export const AppActionsProvider: React.FC<AppActionsProviderProps> = ({ children, value }) => {
  return <AppActionsContext.Provider value={value}>{children}</AppActionsContext.Provider>;
};

/**
 * Hook to access application action callbacks
 *
 * @throws Error if used outside of AppActionsProvider
 *
 * @example
 * const { onSendPrompt, onFork, onUpdateSession } = useAppActions();
 * onSendPrompt(sessionId, "Hello!", "auto");
 */
export const useAppActions = (): AppActionsContextValue => {
  const context = useContext(AppActionsContext);
  if (!context) {
    throw new Error('useAppActions must be used within an AppActionsProvider');
  }
  return context;
};
