import type {
  AgorClient,
  Board,
  Branch,
  PermissionMode,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { Alert, Button, Flex, Spin } from 'antd';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { type AppActionsContextValue, AppActionsProvider } from '../../contexts/AppActionsContext';
import { usePermissionDecision } from '../../hooks/usePermissionDecision';
import { useAgorStore } from '../../store/agorStore';
import { makeSessionMcpServerIdsSelector } from '../../store/selectors';
import { resolveSessionFromShortIdPure } from '../../utils/urlResolution';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { SessionPanel } from '../SessionPanel';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { sessionBoardId } from './sessionBoardId';
import { useMobileBack } from './useMobileBack';

interface SessionPageProps {
  client: AgorClient | null;
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  boardById: Map<string, Board>;
  currentUser?: User | null;
  onSendPrompt?: (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode
  ) => boolean | undefined | Promise<boolean | undefined>;
  onForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onBtwForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onUpdateSession: (sessionId: string, updates: Partial<Session>) => void;
  onDeleteSession: (sessionId: string) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onOpenBranch?: AppActionsContextValue['onOpenBranch'];
  onOpenAgenticToolSettings?: AppActionsContextValue['onOpenAgenticToolSettings'];
}

const EMPTY_MCP_IDS: string[] = [];

/**
 * Full-screen mobile session view. Reuses the shared desktop `SessionPanel`
 * (which owns the whole composer: model / effort / permission / MCP / attach /
 * fork / spawn / btw / stop) so mobile has full feature parity; the previous
 * lossy `MobilePromptInput` is gone. Close exits to the owning board, not history.
 */
export const SessionPage: React.FC<SessionPageProps> = ({
  client,
  sessionById,
  branchById,
  boardById,
  currentUser,
  onSendPrompt,
  onForkSession,
  onBtwForkSession,
  onSpawnSession,
  onUpdateSession,
  onDeleteSession,
  onUpdateSessionMcpServers,
  onUpdateSessionEnvSelections,
  onOpenBranch,
  onOpenAgenticToolSettings,
}) => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const resolvedSessionId = sessionId
    ? sessionById.has(sessionId)
      ? sessionId
      : (resolveSessionFromShortIdPure(sessionId, sessionById) ?? undefined)
    : undefined;
  const session = resolvedSessionId ? sessionById.get(resolvedSessionId) : undefined;
  const branch = session?.branch_id ? (branchById.get(session.branch_id) ?? null) : null;
  const canonicalSessionId = session?.session_id;

  const sessionMcpServerIds =
    useAgorStore(
      useMemo(() => makeSessionMcpServerIdsSelector(canonicalSessionId), [canonicalSessionId])
    ) ?? EMPTY_MCP_IDS;

  const loading = useAgorStore((state) => state.loading);
  const boardId = sessionBoardId(session, branchById, boardById);
  // The leading control is a REAL history Back: it returns to the actual
  // previous surface (previous session, Home, the Sessions list, ...) instead of
  // always dumping the user on the owning board. A cold deep-link has no in-app
  // history (location key === 'default'), so it falls back to the owning board
  // (or Home) — still closing inside Agor. No `replace`, so the back-stack and
  // Forward stay intact.
  const closeSession = useMobileBack(boardId ? `/m/board/${boardId}` : '/m');

  const handlePermissionDecision = usePermissionDecision(client);

  const appActions = useMemo(
    () => ({
      onSendPrompt,
      onFork: onForkSession,
      onBtwFork: onBtwForkSession,
      onSubsession: onSpawnSession,
      onUpdateSession,
      onDeleteSession: (id: string) => {
        onDeleteSession(id);
        closeSession();
      },
      onPermissionDecision: handlePermissionDecision,
      onOpenBranch,
      onOpenAgenticToolSettings,
      onOpenSettings: () => setSettingsOpen(true),
      availableAgents: AVAILABLE_AGENTS,
    }),
    [
      onSendPrompt,
      onForkSession,
      onBtwForkSession,
      onSpawnSession,
      onUpdateSession,
      onDeleteSession,
      closeSession,
      handlePermissionDecision,
      onOpenBranch,
      onOpenAgenticToolSettings,
    ]
  );

  if (!sessionId) {
    return (
      <div style={{ padding: 16 }}>
        <Alert type="error" title="No session ID provided" />
      </div>
    );
  }

  if (!session) {
    return (
      <Flex vertical align="center" justify="center" gap="middle" style={{ height: '100%' }}>
        {loading ? (
          <Spin size="large" />
        ) : (
          // Bootstrap may be complete while the data owner fetches an uncached
          // session. Do not infer a failed request from its absence in the store.
          <Alert
            type="info"
            title="Session not loaded"
            description="It may still be loading or may no longer be available."
          />
        )}
        <Button onClick={closeSession}>Back to home</Button>
      </Flex>
    );
  }

  return (
    <AppActionsProvider value={appActions}>
      {/* Fill the shell's content slot (which already sits ABOVE the docked tab
          bar), not the whole viewport. Using `100dvh` here would push the
          composer down behind the persistent tab bar; `flex: 1` reserves exactly
          the space left over the bar and its safe-area inset. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <SessionPanel
          client={client}
          session={session}
          branch={branch}
          currentUserId={currentUser?.user_id}
          sessionMcpServerIds={sessionMcpServerIds}
          open
          onClose={closeSession}
        />
      </div>
      <SessionSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        session={session}
        onUpdate={onUpdateSession}
        onUpdateSessionMcpServers={onUpdateSessionMcpServers}
        onUpdateSessionEnvSelections={onUpdateSessionEnvSelections}
        client={client}
        currentUser={currentUser}
      />
    </AppActionsProvider>
  );
};
