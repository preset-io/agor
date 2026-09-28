import type { AgorClient } from '@agor-live/client';
import { Alert, Segmented } from 'antd';
import { memo } from 'react';
import type { HomeCommentNeed, HomeNeed, HomeSessionNeed } from '../../store/selectors';
import { HomeCommentRow, HomeFinishedGroupRow, HomeList, HomeSessionRow } from './HomeRow';
import { HomeCard, HomeLink, HomeSection, HomeShowMore, HomeSkeleton } from './HomeSection';

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
  onOpenSession: (sessionId: string) => void;
  onOpenFailure: (sessionId: string) => void;
  onOpenComment: (need: HomeCommentNeed) => void;
  onMarkRead: (sessionId: string) => void;
  /** Shown while any finished result is unopened. */
  onMarkAllRead?: () => void;
  onArchive: (sessionId: string) => void;
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
  onOpenSession,
  onOpenFailure,
  onOpenComment,
  onMarkRead,
  onMarkAllRead,
  onArchive,
}: HomeNeedsYouProps) {
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
          {onMarkAllRead && <HomeLink onClick={onMarkAllRead}>Mark all as read</HomeLink>}
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
          <Alert type="success" showIcon title="You’re all caught up." />
        ) : (
          <HomeSkeleton />
        )
      ) : (
        <HomeCard>
          <HomeList
            items={needs}
            itemKey={(need) => need.key}
            renderItem={(need, index) =>
              'session' in need && need.earlier ? (
                <HomeFinishedGroupRow
                  need={{ ...need, earlier: need.earlier }}
                  onOpen={onOpenSession}
                  onMarkRead={onMarkRead}
                />
              ) : 'session' in need ? (
                <HomeSessionRow
                  session={need.session}
                  reason={need.reason}
                  client={index < NEEDS_PREVIEW ? client : undefined}
                  onOpen={need.reason === 'failed' ? onOpenFailure : onOpenSession}
                  onMarkRead={need.reason === 'finished' ? onMarkRead : undefined}
                  onArchive={need.reason === 'failed' ? onArchive : undefined}
                />
              ) : (
                <HomeCommentRow need={need} onOpen={onOpenComment} />
              )
            }
          />
          {hydrated && hidden > 0 && (
            <HomeShowMore
              expanded={expanded}
              label={expanded ? 'Show less' : `${hidden} more`}
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
