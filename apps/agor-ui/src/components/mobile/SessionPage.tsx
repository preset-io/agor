import type {
  AgorClient,
  Board,
  Branch,
  PermissionMode,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { Alert, Button, Flex, Spin, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { type AppActionsContextValue, AppActionsProvider } from '../../contexts/AppActionsContext';
import { usePermissionDecision } from '../../hooks/usePermissionDecision';
import { usePinnedOpenRows } from '../../hooks/usePinnedRows';
import { useSessionMcpServerIds } from '../../hooks/useSessionMcpServerIds';
import { useAgorStore } from '../../store/agorStore';
import { resolveSessionFromShortIdPure } from '../../utils/urlResolution';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { SessionPanel } from '../SessionPanel';
import { SessionSettingsModal } from '../SessionSettingsModal';
import { mobilePageStyle } from './constants';
import { MobileHeader } from './MobileHeader';
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
  onUpdateSessionMcpServers?: (
    sessionId: string,
    mcpServerIds: string[],
    /** The links the user was shown; the change is diffed against them. */
    baselineIds?: string[]
  ) => void;
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onOpenBranch?: AppActionsContextValue['onOpenBranch'];
  onOpenAgenticToolSettings?: AppActionsContextValue['onOpenAgenticToolSettings'];
}

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
  const { token } = theme.useToken();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const resolvedSessionId = sessionId
    ? sessionById.has(sessionId)
      ? sessionId
      : (resolveSessionFromShortIdPure(sessionId, sessionById) ?? undefined)
    : undefined;
  const session = resolvedSessionId ? sessionById.get(resolvedSessionId) : undefined;
  const branch = session?.branch_id ? (branchById.get(session.branch_id) ?? null) : null;
  const canonicalSessionId = session?.session_id;
  // The open session and its branch stay while shown, whatever scope evicts.
  usePinnedOpenRows({ sessions: [canonicalSessionId] });

  // Loaded on first need; the footer's edit control waits for it.
  const { ids: sessionMcpServerIds } = useSessionMcpServerIds(client, canonicalSessionId);

  const loading = useAgorStore((state) => state.loading);
  // "Not loaded" only once the targeted read missed (`useAgorData`), or once a
  // session this page showed left the store; until then the read may be in flight.
  const missed = useAgorStore((state) => !!sessionId && state.missingLinkTargets.has(sessionId));
  const [shownId, setShownId] = useState<string>();
  if (session && shownId !== sessionId) setShownId(sessionId);
  const waiting = loading || (!missed && shownId !== sessionId);
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
      <div style={{ padding: token.padding }}>
        <Alert type="error" title="No session ID provided" />
      </div>
    );
  }

  if (!session) {
    // Give the missing/loading state the same shell chrome as every other mobile
    // page: a header with a working Back (plus the persistent bottom tab bar,
    // rendered by MobileApp), instead of a bare centered card. Back and the
    // in-body button share the same history-aware handler.
    return (
      <div style={mobilePageStyle}>
        <MobileHeader title="Session" onBack={closeSession} />
        <Flex
          vertical
          align="center"
          justify="center"
          gap="middle"
          style={{ flex: 1, minHeight: 0, padding: token.padding }}
        >
          {waiting ? (
            <Spin size="large" />
          ) : (
            <Alert
              type="info"
              title="Session not loaded"
              description="It may still be loading or may no longer be available."
            />
          )}
          <Button onClick={closeSession}>Back to home</Button>
        </Flex>
      </div>
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
