import type { BoardFileItem } from '@agor-live/client';
import { MessageOutlined } from '@ant-design/icons';
import { Button, Flex, Typography, theme } from 'antd';
import { memo, useEffect, useRef } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { BOARD_FILE_ICONS, boardFileIconColor, boardFileTypeLabel } from '../../utils/boardFiles';
import { formatRelativeTime } from '../../utils/time';
import { HomePressable, HomeRow } from '../HomePage/HomeRow';
import { HomeLink } from '../HomePage/HomeSection';
import { HOME_ROW_LEAD, HOME_ROW_TITLE_WEIGHT } from '../HomePage/homeLayout';
import { TeammatePill } from '../Pill';
import { UserIdentityAvatar } from '../UserIdentityAvatar';

export const BoardFileIcon: React.FC<{ item: Pick<BoardFileItem, 'kind'>; size?: number }> = ({
  item,
  size = HOME_ROW_LEAD,
}) => {
  const { token } = theme.useToken();
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        fontSize: Math.round(size * 0.7),
        color: boardFileIconColor(item.kind, token),
      }}
    >
      {BOARD_FILE_ICONS[item.kind]}
    </span>
  );
};

/** A teammate's emoji and name, or a person's 16px avatar and name. */
export const BoardFileMadeBy: React.FC<{ madeBy: BoardFileItem['made_by'] }> = ({ madeBy }) => {
  const { token } = theme.useToken();
  const userId = 'user_id' in madeBy ? madeBy.user_id : undefined;
  const user = useAgorStore((s) => (userId ? s.userById.get(userId) : undefined));
  if (!('user_id' in madeBy)) {
    return <TeammatePill name={madeBy.name} emoji={madeBy.emoji} compact quiet maxWidth={180} />;
  }
  const name = user?.name || user?.email || 'Someone';
  return (
    <Flex align="center" gap={token.marginXXS} style={{ minWidth: 0 }}>
      <UserIdentityAvatar user={user} size={16} style={{ fontSize: 9, flexShrink: 0 }} />
      <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
        {name}
      </Typography.Text>
    </Flex>
  );
};

/** Where it came from: the conversation as a link, "Private conversation", or "Shared on the board". */
export const BoardFileSource: React.FC<{
  source: BoardFileItem['source'];
  onOpenConversation?: (sessionId: string) => void;
}> = ({ source, onOpenConversation }) => {
  const { token } = theme.useToken();
  if (typeof source === 'object') {
    return (
      <HomeLink
        icon={<MessageOutlined />}
        title="Open conversation"
        onClick={(event) => {
          event.stopPropagation();
          onOpenConversation?.(source.session_id);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        style={{ paddingInline: 0, height: 'auto', maxWidth: 240 }}
      >
        <Typography.Text ellipsis style={{ fontSize: token.fontSizeSM, color: 'inherit' }}>
          {source.title}
        </Typography.Text>
      </HomeLink>
    );
  }
  return (
    <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
      {source === 'private' ? 'Private conversation' : 'Shared on the board'}
    </Typography.Text>
  );
};

/** A Files row, built on Home's row: icon, name, "{type} · {made by} · {from}", time. */
export const BoardFileRow = memo(function BoardFileRow({
  item,
  selected,
  compact,
  onOpen,
  onOpenConversation,
}: {
  item: BoardFileItem;
  selected: boolean;
  /** Narrow: the conversation link is left out, as in Home's compact rows. */
  compact: boolean;
  onOpen: (item: BoardFileItem) => void;
  onOpenConversation: (sessionId: string) => void;
}) {
  const { token } = theme.useToken();
  const type = boardFileTypeLabel(item.kind);
  return (
    <div style={{ background: selected ? token.controlItemBgActive : undefined }}>
      <HomeRow
        lead={<BoardFileIcon item={item} />}
        title={item.name}
        time={formatRelativeTime(item.made_at)}
        ariaLabel={`${item.name}, ${type}`}
        onOpen={() => onOpen(item)}
        meta={
          <>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {type}
            </Typography.Text>
            <BoardFileMadeBy madeBy={item.made_by} />
            {!compact && (
              <BoardFileSource source={item.source} onOpenConversation={onOpenConversation} />
            )}
          </>
        }
      />
    </div>
  );
});

/** A Grid tile: the type icon, the name, "{type} · {time}" (A10: no live thumbnails). */
export const BoardFileTile = memo(function BoardFileTile({
  item,
  selected,
  onOpen,
}: {
  item: BoardFileItem;
  selected: boolean;
  onOpen: (item: BoardFileItem) => void;
}) {
  const { token } = theme.useToken();
  const type = boardFileTypeLabel(item.kind);
  return (
    <HomePressable
      onOpen={() => onOpen(item)}
      ariaLabel={`${item.name}, ${type}`}
      vertical
      style={{
        border: `1px solid ${selected ? token.colorPrimary : token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        overflow: 'hidden',
      }}
    >
      <Flex
        align="center"
        justify="center"
        style={{ height: 88, background: token.colorFillQuaternary }}
      >
        <BoardFileIcon item={item} size={40} />
      </Flex>
      <Flex vertical gap={2} style={{ padding: `${token.paddingXS}px ${token.paddingSM}px` }}>
        <Typography.Text
          ellipsis={{ tooltip: item.name }}
          style={{ fontWeight: HOME_ROW_TITLE_WEIGHT }}
        >
          {item.name}
        </Typography.Text>
        <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
          {type} · {formatRelativeTime(item.made_at)}
        </Typography.Text>
      </Flex>
    </HomePressable>
  );
});

/**
 * Loads the next page when it scrolls into view; it remounts per page, so it
 * fires again if still in view. With `onRetry` that page failed: it says so,
 * and Retry asks for the same page again.
 */
export const LoadMoreSentinel: React.FC<{ onVisible: () => void; onRetry?: () => void }> = ({
  onVisible,
  onRetry,
}) => {
  const { token } = theme.useToken();
  const ref = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  const failed = !!onRetry;
  useEffect(() => {
    const element = ref.current;
    if (failed || !element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisibleRef.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [failed]);
  if (onRetry) {
    return (
      <Flex
        role="alert"
        align="center"
        justify="center"
        gap={token.marginXS}
        style={{ padding: token.paddingSM }}
      >
        <Typography.Text type="secondary">Couldn’t load more.</Typography.Text>
        <Button size="small" onClick={onRetry}>
          Retry
        </Button>
      </Flex>
    );
  }
  return (
    <div
      ref={ref}
      role="status"
      style={{ padding: token.paddingSM, textAlign: 'center', color: token.colorTextTertiary }}
    >
      Loading more…
    </div>
  );
};
