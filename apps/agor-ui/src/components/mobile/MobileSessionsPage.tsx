import type { AgorClient, Branch, Session, SpawnConfig, User } from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { Empty, List, Segmented, Spin, theme } from 'antd';
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBoardPartition } from '../../hooks/useBoardPartition';
import { useAgorStore } from '../../store/agorStore';
import { selectMySessionsLoaded } from '../../store/userScope';
import { isOwnActiveSession, sortSessions } from '../../utils/sessionSearch';
import { BranchSessionSections } from '../BranchCard';
import { mobileScrollAreaStyle } from './constants';
import { MobileHeader } from './MobileHeader';
import { MobileSessionRow } from './MobileSessionRow';

type SessionScope = 'yours' | 'assistant';

interface MobileSessionsPageProps {
  sessionById: Map<string, Session>;
  branchById: Map<string, Branch>;
  userById: Map<string, User>;
  sessionsByBranch: Map<string, Session[]>;
  currentUser?: User | null;
  client: AgorClient | null;
  /** The caller's primary teammate branch, when resolved; enables the Assistant scope. */
  primaryBranch?: Branch | null;
  primaryTeammateName?: string;
  onForkSession: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  /** Opens the agent picker to start a session on the given branch. */
  onCreateSessionOnBranch: (branchId: string) => void;
  /** Unread comments count for the header bell. */
  commentsBadge?: number;
  /** Opens comments/mentions from the header bell. */
  onOpenComments?: () => void;
}

/**
 * Sessions tab. A scope control switches between the caller's own sessions
 * (default, unchanged) and the primary assistant's sessions, which reuse the
 * same BranchSessionSections surface the desktop Teammate tab renders. Yours
 * reads the user scope; the assistant scope loads the assistant's board (its
 * partition, in the background) while shown. Tapping a row opens the shared
 * full-screen session view.
 */
export const MobileSessionsPage: React.FC<MobileSessionsPageProps> = ({
  sessionById,
  branchById,
  userById,
  sessionsByBranch,
  currentUser,
  client,
  primaryBranch,
  primaryTeammateName,
  onForkSession,
  onSpawnSession,
  onCreateSessionOnBranch,
  commentsBadge,
  onOpenComments,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [searchParams, setSearchParams] = useSearchParams();

  const assistantName = primaryTeammateName ?? 'Assistant';
  const canScopeAssistant = !!primaryBranch;
  const scope: SessionScope =
    canScopeAssistant && searchParams.get('scope') === 'assistant' ? 'assistant' : 'yours';

  const yourSessions = useMemo(() => {
    const own = Array.from(sessionById.values()).filter((s) =>
      isOwnActiveSession(s, currentUser?.user_id)
    );
    return sortSessions(own, 'recent');
  }, [sessionById, currentUser?.user_id]);
  // An empty list means "none" only once the caller's sessions have loaded.
  const yourSessionsLoaded = useAgorStore(selectMySessionsLoaded);

  const { boardReady: assistantReady } = useBoardPartition(
    client,
    scope === 'assistant' ? primaryBranch?.board_id : null,
    {
      canUseMemberWorkspaceServices: hasMinimumRole(currentUser?.role, ROLES.MEMBER),
      background: true,
    }
  );
  const assistantSessions = useMemo(
    () => (primaryBranch ? (sessionsByBranch.get(primaryBranch.branch_id) ?? []) : []),
    [primaryBranch, sessionsByBranch]
  );

  const setScope = (next: SessionScope) => {
    setSearchParams(
      (params) => {
        if (next === 'assistant') params.set('scope', 'assistant');
        else params.delete('scope');
        return params;
      },
      { replace: true }
    );
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <MobileHeader
        title="Sessions"
        onSearch={() => navigate('/m/search')}
        commentsBadge={commentsBadge}
        onOpenComments={onOpenComments}
      />
      {canScopeAssistant && (
        <div style={{ paddingInline: token.padding, paddingBottom: token.paddingSM }}>
          <Segmented<SessionScope>
            block
            value={scope}
            onChange={setScope}
            options={[
              { label: 'Yours', value: 'yours' },
              { label: assistantName, value: 'assistant' },
            ]}
          />
        </div>
      )}
      <div style={mobileScrollAreaStyle}>
        {scope === 'assistant' && primaryBranch && !assistantReady ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : scope === 'assistant' && primaryBranch ? (
          <div style={{ paddingInline: token.padding }}>
            <BranchSessionSections
              branch={primaryBranch}
              sessions={assistantSessions}
              userById={userById}
              currentUserId={currentUser?.user_id}
              onSessionClick={(id) => navigate(`/m/session/${id}`)}
              onForkSession={onForkSession}
              onSpawnSession={onSpawnSession}
              onCreateSession={onCreateSessionOnBranch}
              mode="panel"
              client={client}
            />
          </div>
        ) : yourSessions.length === 0 && !yourSessionsLoaded ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : yourSessions.length === 0 ? (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Empty description="No sessions yet. Ask your primary assistant to get started." />
          </div>
        ) : (
          <List
            dataSource={yourSessions}
            style={{ paddingInline: token.padding }}
            renderItem={(session) => (
              <MobileSessionRow
                session={session}
                branch={session.branch_id ? branchById.get(session.branch_id) : undefined}
              />
            )}
          />
        )}
      </div>
    </div>
  );
};
