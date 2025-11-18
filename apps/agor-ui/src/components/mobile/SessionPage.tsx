import type { AgorClient } from '@agor/core/api';
import type { PermissionMode, Repo, Session, User, Worktree } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { Alert, Spin } from 'antd';
import { useParams } from 'react-router-dom';
import { ConversationView } from '../ConversationView';
import { MobileHeader } from './MobileHeader';
import { MobilePromptInput } from './MobilePromptInput';

interface SessionPageProps {
  client: AgorClient | null;
  sessionById: Map<string, Session>; // O(1) ID lookups
  worktreeById: Map<string, Worktree>;
  repos: Repo[];
  users: User[];
  currentUser?: User | null;
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
  onMenuClick?: () => void;
  promptDrafts: Map<string, string>;
  onUpdateDraft: (sessionId: string, draft: string) => void;
}

export const SessionPage: React.FC<SessionPageProps> = ({
  client,
  sessionById,
  worktreeById,
  repos,
  users,
  currentUser,
  onSendPrompt,
  onMenuClick,
  promptDrafts,
  onUpdateDraft,
}) => {
  const { sessionId } = useParams<{ sessionId: string }>();

  const session = sessionId ? sessionById.get(sessionId) : undefined;
  const worktree = session?.worktree_id ? worktreeById.get(session.worktree_id) || null : null;

  if (!sessionId) {
    return (
      <div style={{ padding: 16 }}>
        <Alert type="error" message="No session ID provided" />
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
        decidedBy: currentUser?.user_id || 'anonymous',
      });
    } catch (error) {
      console.error('Failed to send permission decision:', error);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MobileHeader
        title={worktree?.name || 'Session'}
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
          users={users}
          currentUserId={currentUser?.user_id}
          onPermissionDecision={handlePermissionDecision}
          scheduledFromWorktree={session.scheduled_from_worktree}
          scheduledRunAt={session.scheduled_run_at}
          genealogy={session.genealogy}
          emptyStateMessage="Tap the menu icon to browse boards and sessions"
        />
      </div>
      <MobilePromptInput
        onSend={handleSendPrompt}
        disabled={session.status === 'running'}
        placeholder={session.status === 'running' ? 'Agent is working...' : 'Send a prompt...'}
        promptDraft={sessionId ? promptDrafts.get(sessionId) || '' : ''}
        onUpdateDraft={(draft: string) => sessionId && onUpdateDraft(sessionId, draft)}
      />
    </div>
  );
};
