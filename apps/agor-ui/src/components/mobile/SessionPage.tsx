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
  sessions: Session[];
  worktrees: Worktree[];
  repos: Repo[];
  users: User[];
  currentUser?: User | null;
  onSendPrompt?: (sessionId: string, prompt: string, permissionMode?: PermissionMode) => void;
}

export const SessionPage: React.FC<SessionPageProps> = ({
  client,
  sessions,
  worktrees,
  repos,
  users,
  currentUser,
  onSendPrompt,
}) => {
  const { sessionId } = useParams<{ sessionId: string }>();

  const session = sessions.find(s => s.session_id === sessionId);
  const worktree = session ? worktrees.find(w => w.worktree_id === session.worktree_id) : null;

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
      <MobileHeader title={worktree?.name || 'Session'} showBack user={currentUser} />
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingBottom: 80, // Space for fixed input
        }}
      >
        <ConversationView
          client={client}
          session={session}
          worktree={worktree}
          repos={repos}
          worktrees={worktrees}
          users={users}
          onPermissionDecision={handlePermissionDecision}
          // Mobile-specific: don't show worktree/terminal links
          onOpenWorktree={undefined}
          onOpenTerminal={undefined}
        />
      </div>
      <MobilePromptInput
        onSend={handleSendPrompt}
        disabled={session.status === 'running'}
        placeholder={session.status === 'running' ? 'Agent is working...' : 'Send a prompt...'}
      />
    </div>
  );
};
