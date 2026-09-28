import type { AgorClient, Board, Branch, EffectiveBranchAccess, User } from '@agor-live/client';
import { getTeammateConfig, TEAMMATE_FRAMEWORK_REPO_SLUG } from '@agor-live/client';
import { SyncOutlined } from '@ant-design/icons';
import { Avatar, Button, Flex, Typography, theme } from 'antd';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionState } from '../../contexts/ConnectionContext';
import { useBoardsSharedWithMe } from '../../hooks/useBoardsSharedWithMe';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import { makeTeammatesSelector } from '../../store/selectors';
import { peekAccess, readAccess } from '../../utils/accessCache';
import { canStartSessions } from '../../utils/branchAccess';
import { teammateEmoji, teammateLabel } from '../../utils/teammateLabels';
import { getTemplateBySourceBranch } from '../../utils/teammateTemplates';
import { HomePressable } from './HomeRow';
import { HomeCard, HomeLink, HomeSection, HomeSkeleton } from './HomeSection';

const RAIL_SIZE = 3;

/** Home board description, then the template it was cut from; otherwise none. */
export function teammatePurpose(branch: Branch, board?: Board): string | undefined {
  const described = board?.description?.trim();
  if (described) return described;
  if (getTeammateConfig(branch)?.frameworkRepo !== TEAMMATE_FRAMEWORK_REPO_SLUG) return undefined;
  return getTemplateBySourceBranch(branch.base_ref?.replace(/^(refs\/heads\/|origin\/)/, ''))
    ?.description;
}

export const teammateOwner = (branch: Branch) => branch.primary_owner_user_id ?? branch.created_by;

export const canStartSessionsOn = (client: AgorClient, branchId: string) =>
  client
    .service('branches/:id/effective-access')
    .find({ route: { id: branchId } })
    .then((access) => canStartSessions(access as unknown as EffectiveBranchAccess));

/**
 * Session access for the given teammates, read through the shared access cache.
 * `settled` once every id has an answer or a failed read (unknown stays out of
 * `access`).
 */
export function useSessionAccess(
  client: AgorClient | null,
  userId: string | undefined,
  branchIds: string[]
) {
  const { authGeneration } = useConnectionState();
  const scope = `${userId}:${authGeneration}`;
  const key = branchIds.join(',');
  const [version, setVersion] = useState(0);
  const failed = useRef({ scope, ids: new Set<string>() });
  if (failed.current.scope !== scope) failed.current = { scope, ids: new Set() };
  useEffect(() => {
    if (!client || !userId || !key) return;
    let cancelled = false;
    const ids = failed.current.ids;
    for (const id of key.split(',')) {
      if (peekAccess(client, scope, `branch:${id}`) !== undefined || ids.has(id)) continue;
      readAccess(client, scope, `branch:${id}`, () => canStartSessionsOn(client, id))
        .catch(() => ids.add(id))
        .then(() => !cancelled && setVersion((v) => v + 1));
    }
    return () => {
      cancelled = true;
    };
  }, [client, userId, scope, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the cache after a read settles
  return useMemo(() => {
    const access: Record<string, boolean> = {};
    let settled = true;
    for (const id of client && userId && key ? key.split(',') : []) {
      const known = peekAccess(client as AgorClient, scope, `branch:${id}`);
      if (known !== undefined) access[id] = known;
      else settled &&= failed.current.ids.has(id);
    }
    return { access, settled };
  }, [client, userId, scope, key, version]);
}

/** Others' teammates whose home board reaches the caller through its policy. */
export function useSharedTeammates(client: AgorClient | null, user: User | null | undefined) {
  const candidates = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => makeTeammatesSelector(user?.user_id, 'shared'), [user?.user_id]),
    shallow
  );
  const boardIds = useMemo(() => candidates.map((b) => b.board_id ?? ''), [candidates]);
  const sharedWithMe = useBoardsSharedWithMe(client, user, boardIds);
  return useMemo(
    () => candidates.filter((branch) => sharedWithMe(branch.board_id ?? '')),
    [candidates, sharedWithMe]
  );
}

export interface TeammateCardProps {
  branch: Branch;
  /** Shows "View only · ask {owner} for access" once access is known to stop at view. */
  viewOnly?: boolean;
  onOpenBoard?: (boardId: string) => void;
}

export const TeammateCard = memo(function TeammateCard({
  branch,
  viewOnly,
  onOpenBoard,
}: TeammateCardProps) {
  const { token } = theme.useToken();
  const owner = useAgorStore((s) => s.userById.get(teammateOwner(branch)));
  const board = useAgorStore((s) =>
    branch.board_id ? s.boardById.get(branch.board_id) : undefined
  );
  const ownerName = owner?.name || owner?.email || 'its owner';
  const purpose = teammatePurpose(branch, board);
  const small = { fontSize: token.fontSizeSM };
  return (
    <HomePressable
      onOpen={board && onOpenBoard ? () => onOpenBoard(board.board_id) : undefined}
      ariaLabel={`${teammateLabel(branch)}, open ${board?.name}`}
      tooltip={`Open ${board?.name}`}
      vertical
      gap={token.marginXS}
      style={{ padding: token.paddingSM }}
    >
      <Flex align="center" gap={token.marginSM} style={{ minWidth: 0 }}>
        <Avatar
          shape="square"
          size={32}
          style={{ background: token.colorFillSecondary, flex: '0 0 auto' }}
        >
          <span style={{ fontSize: token.fontSizeLG }}>{teammateEmoji(branch) ?? '🤖'}</span>
        </Avatar>
        <Flex vertical style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong ellipsis>
            {teammateLabel(branch)}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={small}>
            by {ownerName}
          </Typography.Text>
        </Flex>
      </Flex>
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2, tooltip: purpose }}
        style={{ ...small, margin: 0, color: purpose ? undefined : token.colorTextTertiary }}
      >
        {purpose ?? 'No description yet'}
      </Typography.Paragraph>
      {viewOnly && (
        <Typography.Text type="secondary" style={small}>
          View only · ask {ownerName} for access
        </Typography.Text>
      )}
    </HomePressable>
  );
});

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
  const teammates = useSharedTeammates(client, currentUser);
  const hydrated = useAgorStore((s) => s.branchesHydrated);
  const [offset, setOffset] = useState(0);
  const shown = useMemo(
    () =>
      teammates.length <= RAIL_SIZE
        ? teammates
        : [...teammates.slice(offset % teammates.length), ...teammates].slice(0, RAIL_SIZE),
    [teammates, offset]
  );
  const { access } = useSessionAccess(
    checkAccess ? client : null,
    currentUser?.user_id,
    shown.map((b) => b.branch_id)
  );
  if (hydrated && teammates.length === 0) return null;
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
          {onSeeAll && <HomeLink onClick={onSeeAll}>See all {teammates.length}</HomeLink>}
        </>
      }
    >
      {shown.length === 0 ? (
        <HomeSkeleton />
      ) : (
        <HomeCard>
          {shown.map((branch, index) => (
            <div
              key={branch.branch_id}
              style={index ? { borderTop: `1px solid ${token.colorSplit}` } : undefined}
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
    </HomeSection>
  );
});
