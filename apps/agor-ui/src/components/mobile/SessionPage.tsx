import type {
  AgorClient,
  Branch,
  PermissionMode,
  Repo,
  Session,
  SessionID,
  User,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate, PermissionScope } from '@agor-live/client';
import { Alert, Spin } from 'antd';
import { useParams } from 'react-router-dom';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { ConversationView } from '../ConversationView';
import { MobileHeader } from './MobileHeader';
import { MobilePromptInput } from './MobilePromptInput';

interface SessionPageProps {
  client: AgorClient | null;
  sessionById: Map<string, Session>; // O(1) ID lookups
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  userById: Map<string, User>;
  currentUser?: User | null;
  onSendPrompt?: (
    sessionId: string,
    prompt: string,
    permissionMode?: PermissionMode
  ) => boolean | undefined | Promise<boolean | undefined>;
  onMenuClick?: () => void;
  promptDrafts: Map<string, string>;
  onUpdateDraft: (sessionId: string, draft: string) => void;
}

export const SessionPage: React.FC<SessionPageProps> = ({
  client,
  sessionById,
  branchById,
  repoById,
  userById,
  currentUser,
  onSendPrompt,
  onMenuClick,
  promptDrafts,
  onUpdateDraft,
}) => {
  const { sessionId } = useParams<{ sessionId: string }>();

  const session = sessionId ? sessionById.get(sessionId) : undefined;
  const branch = session?.branch_id ? branchById.get(session.branch_id) || null : null;

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
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spin size="large" />
      </div>
    );
  }

  const handleSendPrompt = (prompt: string) => {
    onSendPrompt?.(sessionId, prompt);
  };

  const handlePermissionDecision = async (
    _sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => {
    if (!client) return;

    try {
      await client.service(`sessions/${_sessionId}/permission-decision`).create({
        requestId,
        taskId,
        allow,
        reason: allow ? 'Approved by user' : 'Denied by user',
        remember: scope !== PermissionScope.ONCE,
        scope,
        decidedBy: currentUser?.user_id || 'unknown',
      });
    } catch (error) {
      console.error('Failed to send permission decision:', error);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MobileHeader
        title={
          branch?.name ||
          getSessionDisplayTitle(session, { fallbackChars: 30, includeIdFallback: true })
        }
        showMenu
        user={currentUser}
        onMenuClick={onMenuClick}
      />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingBottom: 80, // Space for fixed input
        }}
      >
        <ConversationView
          client={client}
          sessionId={session.session_id}
          agentic_tool={session.agentic_tool}
          sessionModel={session.model_config?.model}
          userById={userById}
          currentUserId={currentUser?.user_id}
          onPermissionDecision={handlePermissionDecision}
          scheduledFromBranch={session.scheduled_from_branch}
          scheduledRunAt={session.scheduled_run_at}
          genealogy={session.genealogy}
          emptyStateMessage="Tap the menu icon to browse boards and sessions"
          teammateEmoji={
            branch && isTeammate(branch) ? getTeammateConfig(branch)?.emoji : undefined
          }
        />
      </div>
      <MobilePromptInput
        onSend={handleSendPrompt}
        disabled={session.status === 'running'}
        placeholder={session.status === 'running' ? 'Agent is working...' : 'Send a prompt...'}
        promptDraft={sessionId ? promptDrafts.get(sessionId) || '' : ''}
        onUpdateDraft={(draft: string) => sessionId && onUpdateDraft(sessionId, draft)}
        client={client}
        sessionId={(sessionId as SessionID) || null}
        userById={userById}
      />
    </div>
  );
};
