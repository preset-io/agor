import { LoadingOutlined } from '@ant-design/icons';
import { Flex, Tooltip, theme } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import { getTimeMs } from '../../utils/entityTime';

export const HomeStatsBar: React.FC<{
  currentUserId?: string;
}> = ({ currentUserId }) => {
  const { token } = theme.useToken();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const teamSize = useAgorStore((s) => s.userById.size);

  // Derived counts with shallow equality: session patches that don't change
  // any count (e.g. streaming updates to an already-active session) leave the
  // stats bar un-rendered.
  const { activeTeammates, myThisWeek, runningNow, activeThisWeek } = useStoreWithEqualityFn(
    agorStore,
    (state) => {
      const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

      const activeUserIds = new Set<string>();
      let myThisWeek = 0;
      let runningNow = 0;
      let activeThisWeek = 0;

      for (const s of state.sessionById.values()) {
        if (s.archived) continue;

        const lastUpdated = getTimeMs(s, 'last_updated');
        const updatedAt = Number.isNaN(lastUpdated) ? getTimeMs(s, 'created_at') : lastUpdated;

        if (s.status === 'running') {
          runningNow++;
        }

        if (!Number.isNaN(updatedAt) && updatedAt > weekAgo) {
          activeThisWeek++;
          if (s.created_by) activeUserIds.add(s.created_by);
          if (s.created_by === currentUserId) {
            myThisWeek++;
          }
        }
      }

      return {
        activeTeammates: activeUserIds.size,
        myThisWeek,
        runningNow,
        activeThisWeek,
      };
    },
    shallow
  );

  const isMultiUser = teamSize > 1;
  const weekValue =
    isMultiUser && currentUserId && activeThisWeek > 0
      ? `${myThisWeek}/${activeThisWeek}`
      : activeThisWeek;
  const weekTooltip =
    isMultiUser && currentUserId && activeThisWeek > 0
      ? `${myThisWeek} by you, ${activeThisWeek} by the team`
      : undefined;

  const separator = <span style={{ color: token.colorTextQuaternary }}>·</span>;

  // The three workspace stats as one quiet line under the greeting.
  return (
    <Flex
      align="center"
      gap={token.marginXS}
      wrap
      style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }}
    >
      {runningNow > 0 ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: token.marginXXS }}>
          <LoadingOutlined spin style={{ color: token.colorSuccess, fontSize: 11 }} />
          <span style={{ color: token.colorTextSecondary }}>{runningNow} running now</span>
        </span>
      ) : (
        <span>Nothing running</span>
      )}
      {separator}
      <Tooltip title={weekTooltip}>
        <span>{weekValue} sessions active this week</span>
      </Tooltip>
      {separator}
      <span>
        {activeTeammates} teammate{activeTeammates !== 1 ? 's' : ''} active this week
      </span>
    </Flex>
  );
};
