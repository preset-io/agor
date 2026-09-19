import type {
  AgorClient,
  Branch,
  PermissionMode,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { Alert, Spin } from 'antd';
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
import { useMobileBack } from './useMobileBack';

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
  onUpdateSessionEnvSelections?: (sessionId: string, envVarNames: string[]) => void;
  onOpenBranch?: AppActionsContextValue['onOpenBranch'];
  onOpenAgenticToolSettings?: AppActionsContextValue['onOpenAgenticToolSettings'];
}

const EMPTY_MCP_IDS: string[] = [];

/**
 * Full-screen mobile session view. Reuses the shared desktop `SessionPanel`
 * (which owns the whole composer: model / effort / permission / MCP / attach /
 * fork / spawn / btw / stop) so mobile has full feature parity; the previous
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

  const goBack = useMobileBack('/m/sessions');

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
        goBack();
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
      goBack,
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
      <div
        style={{
          height: '100%',
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
        onUpdateSessionEnvSelections={onUpdateSessionEnvSelections}
        client={client}
        currentUser={currentUser}
      />
    </AppActionsProvider>
  );
};
