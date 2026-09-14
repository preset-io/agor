import type {
  AgorClient,
  Branch,
  PermissionMode,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { PermissionScope } from '@agor-live/client';
import { Alert, Spin } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { useAgorStore } from '../../store/agorStore';
import { makeSessionMcpServerIdsSelector } from '../../store/selectors';
import { resolveSessionFromShortIdPure } from '../../utils/urlResolution';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid';
import { SessionPanel } from '../SessionPanel';
import { SessionSettingsModal } from '../SessionSettingsModal';

interface SessionPageProps {
  client: AgorClient | null;
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
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
}

const EMPTY_MCP_IDS: string[] = [];

/**
 * Full-screen mobile session view. Reuses the shared desktop `SessionPanel`
 * (which owns the whole composer: model / effort / permission / MCP / attach /
 * fork / spawn / btw / stop) so mobile has full feature parity — the previous
 * lossy `MobilePromptInput` is gone. Back returns to the actual parent route.
 */
export const SessionPage: React.FC<SessionPageProps> = ({
  client,
  sessionById,
  branchById,
  currentUser,
  onSendPrompt,
  onForkSession,
  onBtwForkSession,
  onSpawnSession,
  onUpdateSession,
  onDeleteSession,
  onUpdateSessionMcpServers,
}) => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
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

  // Back to the actual parent (the branch/board/sessions route the user came
  // from). `navigate(-1)` unwinds the real history entry; falling back to the
  // mobile home keeps a cold deep-link from dead-ending.
  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/m');
  }, [navigate]);

  const handlePermissionDecision = useCallback(
    async (
      decisionSessionId: string,
      requestId: string,
      taskId: string,
      allow: boolean,
      scope: PermissionScope
    ) => {
      if (!client) return;
      try {
        await client.service(`sessions/${decisionSessionId}/permission-decision`).create({
          requestId,
          taskId,
          allow,
          reason: allow ? 'Approved by user' : 'Denied by user',
          remember: scope !== PermissionScope.ONCE,
          scope,
        });
      } catch (error) {
        console.error('Failed to send permission decision:', error);
      }
    },
    [client]
  );

  const appActions = useMemo(
    () => ({
      onSendPrompt,
      onFork: onForkSession,
      onBtwFork: onBtwForkSession,
      onSubsession: onSpawnSession,
      onUpdateSession,
      onDeleteSession: (id: string) => {
        onDeleteSession(id);
        goBack();
      },
      onPermissionDecision: handlePermissionDecision,
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
      goBack,
      handlePermissionDecision,
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
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  return (
    <AppActionsProvider value={appActions}>
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <SessionPanel
          client={client}
          session={session}
          branch={branch}
          currentUserId={currentUser?.user_id}
          sessionMcpServerIds={sessionMcpServerIds}
          open
          onClose={goBack}
        />
      </div>
      <SessionSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        session={session}
        onUpdate={onUpdateSession}
        onUpdateSessionMcpServers={onUpdateSessionMcpServers}
        client={client}
        currentUser={currentUser}
      />
    </AppActionsProvider>
  );
};
