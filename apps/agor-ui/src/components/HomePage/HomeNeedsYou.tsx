import type { AgorClient } from '@agor-live/client';
import { Alert, Segmented } from 'antd';
import { memo, useCallback } from 'react';
import { useEnsureBranches, useEnsureSessions } from '../../hooks/useEnsureRows';
import { type AgorState, useAgorStore } from '../../store/agorStore';
import type { HomeCommentNeed, HomeNeed, HomeSessionNeed } from '../../store/selectors';
import { HomeCommentRow, HomeList, HomeNeedRow } from './HomeRow';
import { HomeCard, HomeLink, HomeSection, HomeShowMore, HomeSkeleton } from './HomeSection';
import { formatCount } from './homeLayout';

export const NEEDS_PREVIEW = 3;
export const NEEDS_MAX = 50;

const NEEDS_INFO =
  'Permission requests, comments for you, failures and results you haven’t opened.\nThey leave when you act.';

export type NeedsFilter = 'all' | 'comments';

type NeedKind = HomeSessionNeed['reason'] | 'comment';

/** Needs you order, with each kind's singular and plural noun. */
const KIND_NOUNS: [NeedKind, string, string][] = [
  ['permission', 'permission request', 'permission requests'],
  ['comment', 'comment', 'comments'],
  ['failed', 'failed', 'failed'],
  ['finished', 'finished', 'finished'],
];

/** "4 finished, 2 comments": what the rows after the preview are, non-zero kinds only. */
function hiddenBreakdown(counts: Record<NeedKind, number>, preview: HomeNeed[]) {
  const left = { ...counts };
  for (const need of preview) left['session' in need ? need.reason : 'comment']--;
  return KIND_NOUNS.filter(([kind]) => left[kind] > 0)
    .map(([kind, one, many]) => `${left[kind]} ${left[kind] === 1 ? one : many}`)
    .join(', ');
}

interface HomeNeedsYouProps {
  client: AgorClient | null;
  needs: HomeNeed[];
  needsCount: number;
  needsByReason: Readonly<Record<HomeSessionNeed['reason'], number>>;
  commentCount: number;
  filter: NeedsFilter;
  onFilterChange: (filter: NeedsFilter) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Counts and "all caught up" wait for the full session set; rows don't. */
  hydrated: boolean;
  /** My sessions were read only up to the cap: counts are lower bounds, never "caught up". */
  truncated?: boolean;
  onOpenSession: (sessionId: string) => void;
  /** Gets the whole need: a failure group's header stands for its earlier failures too. */
  onOpenFailure: (need: HomeSessionNeed) => void;
  onOpenComment: (need: HomeCommentNeed) => void;
  onMarkRead: (sessionId: string) => void;
  /** Shown while any finished result is unopened. */
  onMarkAllRead?: () => void;
  markingAllRead?: boolean;
  /** While the connection can't take changes. */
  markAllReadDisabled?: boolean;
  /** Omitted while the connection can't take changes. */
  onArchive?: (sessionId: string) => void;
}

export const HomeNeedsYou = memo(function HomeNeedsYou({
  client,
  needs,
  needsCount,
  needsByReason,
  commentCount,
  filter,
  onFilterChange,
  expanded,
  onExpandedChange,
  hydrated,
  truncated = false,
  onOpenSession,
  onOpenFailure,
  onOpenComment,
  onMarkRead,
  onMarkAllRead,
  markingAllRead,
  markAllReadDisabled,
  onArchive,
}: HomeNeedsYouProps) {
  // The store holds only the loaded scopes: read the shown comment rows'
  // target sessions, and the branches their chips name, by id.
  const targets = needs
    .flatMap((need) => ('session' in need ? [] : [need.thread]))
    .map((thread) => `${thread.branch_id ?? ''} ${thread.session_id ?? ''}`)
    .join(',');
  useEnsureSessions(
    client,
    targets.split(',').map((target) => target.split(' ')[1])
  );
  const branchKey = useAgorStore(
    useCallback(
      (s: AgorState) =>
        targets
          .split(',')
          .map((target) => {
            const [branchId, sessionId] = target.split(' ');
            return branchId || s.sessionById.get(sessionId)?.branch_id || '';
          })
          .join(','),
      [targets]
    )
  );
  useEnsureBranches(client, branchKey.split(','));

  const total = Math.min(filter === 'comments' ? commentCount : needsCount, NEEDS_MAX);
  const hidden = total - NEEDS_PREVIEW;
  const sessions =
    filter === 'comments' ? { permission: 0, failed: 0, finished: 0 } : needsByReason;

  return (
    <HomeSection
      id="needs"
      title="Needs you"
      info={NEEDS_INFO}
      extra={
        <>
          {onMarkAllRead && (
            <HomeLink
              loading={markingAllRead}
              disabled={markAllReadDisabled || markingAllRead}
              onClick={onMarkAllRead}
            >
              Mark all as read
            </HomeLink>
          )}
          {commentCount > 0 && (
            <Segmented<NeedsFilter>
              size="small"
              value={filter}
              onChange={onFilterChange}
              options={[
                { value: 'all', label: 'All' },
                { value: 'comments', label: `Comments ${commentCount}` },
              ]}
            />
          )}
        </>
      }
    >
      {needs.length === 0 ? (
        hydrated ? (
          truncated ? (
            <Alert type="info" showIcon title="Nothing needs you in your most recent sessions." />
          ) : (
            <Alert type="success" showIcon title="You’re all caught up." />
          )
        ) : (
          <HomeSkeleton />
        )
      ) : (
        <HomeCard>
          <HomeList
            items={needs}
            itemKey={(need) => need.key}
            renderItem={(need, index) =>
              'session' in need ? (
                <HomeNeedRow
                  need={need}
                  client={index < NEEDS_PREVIEW ? client : undefined}
                  onOpenSession={onOpenSession}
                  onOpenFailure={onOpenFailure}
                  onMarkRead={onMarkRead}
                  onArchive={onArchive}
                />
              ) : (
                <HomeCommentRow need={need} onOpen={onOpenComment} />
              )
            }
          />
          {hydrated && hidden > 0 && (
            <HomeShowMore
              expanded={expanded}
              label={
                expanded
                  ? 'Show less'
                  : `${formatCount(hidden, truncated && filter !== 'comments')} more`
              }
              detail={
                expanded
                  ? undefined
                  : hiddenBreakdown(
                      { ...sessions, comment: commentCount },
                      needs.slice(0, NEEDS_PREVIEW)
                    )
              }
              onClick={() => onExpandedChange(!expanded)}
            />
          )}
        </HomeCard>
      )}
    </HomeSection>
  );
});
