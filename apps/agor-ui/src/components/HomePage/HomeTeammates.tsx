import type { AgorClient, User } from '@agor-live/client';
import { SyncOutlined } from '@ant-design/icons';
import { Button, Typography, theme } from 'antd';
import { memo, useMemo, useState } from 'react';
import { useSessionAccess } from '../../hooks/useSessionAccess';
import { useSharedTeammates } from '../../hooks/useSharedTeammates';
import { useAgorStore } from '../../store/agorStore';
import { selectTeammatesLoaded, selectTeammatesTruncated } from '../../store/userScope';
import { TeammateCard } from '../TeammateCard';
import { HomeCard, HomeLink, HomeSection, HomeSkeleton } from './HomeSection';
import { formatCount, homeDivider } from './homeLayout';

const RAIL_SIZE = 3;

interface HomeTeammatesSectionProps {
  client: AgorClient | null;
  currentUser?: User | null;
  /** Read session access for the shown cards (callers who can start sessions). */
  checkAccess?: boolean;
  onOpenBoard: (boardId: string) => void;
  onSeeAll?: () => void;
}

export const HomeTeammatesSection = memo(function HomeTeammatesSection({
  client,
  currentUser,
  checkAccess,
  onOpenBoard,
  onSeeAll,
}: HomeTeammatesSectionProps) {
  const { token } = theme.useToken();
  const {
    teammates,
    failed: sharingFailed,
    retry: retrySharing,
    retrying: sharingRetrying,
  } = useSharedTeammates(client, currentUser);
  const hydrated = useAgorStore(selectTeammatesLoaded);
  const truncated = useAgorStore(selectTeammatesTruncated);
  const [offset, setOffset] = useState(0);
  const shown = useMemo(
    () =>
      teammates.length <= RAIL_SIZE
        ? teammates
        : [...teammates.slice(offset % teammates.length), ...teammates].slice(0, RAIL_SIZE),
    [teammates, offset]
  );
  const {
    access,
    failed: accessFailed,
    retry: retryAccess,
    retrying: accessRetrying,
  } = useSessionAccess(
    checkAccess ? client : null,
    currentUser,
    shown.map((b) => b.branch_id)
  );
  const retry = () => {
    if (sharingFailed > 0) retrySharing();
    if (accessFailed > 0) retryAccess();
  };
  if (hydrated && teammates.length === 0 && sharingFailed === 0) return null;
  return (
    <HomeSection
      id="teammates"
      title="AI teammates"
      extra={
        <>
          {teammates.length > RAIL_SIZE && (
            <Button
              type="text"
              size="small"
              icon={<SyncOutlined />}
              aria-label="Show other teammates"
              onClick={() => setOffset((o) => o + RAIL_SIZE)}
            />
          )}
          {/* Nothing to list yet (e.g. every read failed): the failure notice says why. */}
          {onSeeAll && teammates.length > 0 && (
            <HomeLink onClick={onSeeAll}>
              See all {formatCount(teammates.length, truncated)}
            </HomeLink>
          )}
        </>
      }
    >
      {shown.length === 0 ? (
        sharingFailed === 0 && <HomeSkeleton />
      ) : (
        <HomeCard>
          {shown.map((branch, index) => (
            <div
              key={branch.branch_id}
              style={index ? { borderTop: homeDivider(token) } : undefined}
            >
              <TeammateCard
                branch={branch}
                viewOnly={access[branch.branch_id] === false}
                onOpenBoard={onOpenBoard}
              />
            </div>
          ))}
        </HomeCard>
      )}
      {sharingFailed + accessFailed > 0 && (
        <Typography.Text
          type="secondary"
          style={{ display: 'block', marginTop: token.marginXS, fontSize: token.fontSizeSM }}
        >
          Couldn’t check access for some teammates.{' '}
          {/* Loading, not hidden, while retried reads are out, so focus stays on it. */}
          <HomeLink onClick={retry} loading={sharingRetrying || accessRetrying}>
            Try again
          </HomeLink>
        </Typography.Text>
      )}
    </HomeSection>
  );
});
