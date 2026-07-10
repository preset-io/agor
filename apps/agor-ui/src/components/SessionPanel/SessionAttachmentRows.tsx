import {
  EllipsisOutlined,
  GithubOutlined,
  GlobalOutlined,
  LinkOutlined,
  PushpinFilled,
  PushpinOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { isFileLinkDisplayItem, isKnowledgeLinkDisplayItem } from '../Links';
import { LinkAttachmentGlyph } from '../Links/LinkAttachmentCard';
import {
  canDownloadSessionFile,
  canPreviewSessionImage,
  getSessionAttachmentTargetDisplay,
  type SessionAttachmentItem,
  sessionAttachmentDisabledReason,
} from './sessionAttachmentModel';

export interface SessionAttachmentTeammateState {
  isPromoted: boolean;
  teammateLinkId?: string;
  disabled?: boolean;
  loading?: boolean;
  unavailableReason?: string | null;
}

interface SharedProps {
  item: SessionAttachmentItem;
  pinningLinkId?: string | null;
  onOpen: (item: SessionAttachmentItem) => void;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
}

interface DrawerProps extends SharedProps {
  getTeammateActionState?: (item: SessionAttachmentItem) => SessionAttachmentTeammateState | null;
  onPromoteToTeammate?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRemoveFromTeammate?: (
    item: SessionAttachmentItem,
    teammateLinkId: string
  ) => void | Promise<void>;
  teammatePromotionBusyKey?: string | null;
}

function attachmentIcon(item: SessionAttachmentItem, disabled: boolean): React.ReactNode {
  if (isFileLinkDisplayItem(item) || isKnowledgeLinkDisplayItem(item)) {
    return (
      <LinkAttachmentGlyph
        kind={item.kind}
        mimeType={item.mimeType}
        title={item.name}
        filePath={item.filePath}
        refUri={item.refUri}
        disabled={disabled}
        size="sm"
      />
    );
  }
  if (disabled) return <StopOutlined />;
  const target = item.url ?? item.refUri ?? '';
  try {
    const { hostname } = new URL(target);
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return <GithubOutlined />;
  } catch {
    // Ignore non-URL targets; availability is handled by the canonical resolver.
  }
  return item.category === 'url' ? <GlobalOutlined /> : <LinkOutlined />;
}

function stopNavigation(event: React.MouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

function handleRowKeyDown(
  item: SessionAttachmentItem,
  onOpen: (item: SessionAttachmentItem) => void
): React.KeyboardEventHandler<HTMLElement> {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(item);
  };
}

function canTogglePinned(
  item: SessionAttachmentItem,
  onTogglePinned?: SharedProps['onTogglePinned']
) {
  return item.ownerScope === 'session' && Boolean(item.linkId) && Boolean(onTogglePinned);
}

function PinAction({ item, pinningLinkId, onTogglePinned }: SharedProps) {
  const { token } = theme.useToken();
  const toggleable = canTogglePinned(item, onTogglePinned);
  const isPinning = Boolean(item.linkId && pinningLinkId === item.linkId);
  const label = toggleable
    ? item.isPinned
      ? 'Unpin from session header'
      : 'Pin in session'
    : item.ownerScope === 'branch'
      ? 'Pin is read-only here'
      : 'Pin unavailable';
  return (
    <Tooltip title={label}>
      <button
        type="button"
        aria-label={label}
        aria-disabled={!toggleable || isPinning || undefined}
        onClick={(event) => {
          stopNavigation(event);
          if (toggleable && !isPinning) void onTogglePinned?.(item);
        }}
        style={{
          border: 0,
          background: 'transparent',
          padding: 0,
          color: item.isPinned ? token.colorWarning : token.colorTextQuaternary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          cursor: toggleable && !isPinning ? 'pointer' : 'default',
          opacity: isPinning ? 0.6 : 1,
        }}
      >
        {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
      </button>
    </Tooltip>
  );
}

function PromotionAction(props: DrawerProps) {
  const { token } = theme.useToken();
  const state = props.getTeammateActionState?.(props.item);
  if (!state) return <span aria-hidden />;
  const busyKey = state.teammateLinkId ?? props.item.linkId ?? props.item.key;
  const busy = state.loading || props.teammatePromotionBusyKey === busyKey;
  const disabled = state.disabled || busy || (state.isPromoted && !state.teammateLinkId);
  const label = state.isPromoted ? 'Remove from teammate' : 'Promote to teammate';
  const items: MenuProps['items'] = [
    {
      key: state.isPromoted ? 'remove-teammate' : 'promote-teammate',
      label,
      disabled,
      title: state.unavailableReason ?? undefined,
    },
  ];
  return (
    <Tooltip title={state.unavailableReason ?? 'Teammate link actions'}>
      <Dropdown
        trigger={['click']}
        menu={{
          items,
          onClick: ({ domEvent }) => {
            domEvent.preventDefault();
            domEvent.stopPropagation();
            if (disabled) return;
            if (state.isPromoted && state.teammateLinkId) {
              void props.onRemoveFromTeammate?.(props.item, state.teammateLinkId);
            } else {
              void props.onPromoteToTeammate?.(props.item);
            }
          },
        }}
      >
        <Button
          type="text"
          size="small"
          aria-label={`Teammate actions for ${props.item.name}`}
          loading={busy}
          icon={<EllipsisOutlined />}
          onClick={stopNavigation}
          style={{
            width: 24,
            minWidth: 24,
            height: 24,
            padding: 0,
            color: token.colorTextTertiary,
          }}
        />
      </Dropdown>
    </Tooltip>
  );
}

export function SessionAttachmentQuickRow(props: SharedProps) {
  const { token } = theme.useToken();
  const disabledReason = sessionAttachmentDisabledReason(props.item);
  const disabled = Boolean(disabledReason);
  const tooltip =
    disabledReason ??
    (canPreviewSessionImage(props.item)
      ? 'Preview image'
      : canDownloadSessionFile(props.item)
        ? 'Download file'
        : 'Open link');
  return (
    <Tooltip title={tooltip} placement="left">
      <div
        className="agor-action-link-row"
        role={disabled ? undefined : 'link'}
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        onClick={() => props.onOpen(props.item)}
        onKeyDown={handleRowKeyDown(props.item, props.onOpen)}
        style={
          {
            '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
            '--agor-link-icon-color': disabled ? token.colorTextDisabled : token.colorTextTertiary,
            '--agor-link-row-hover-bg': token.colorFillTertiary,
            '--agor-link-row-hover-color': token.colorPrimary,
            width: '100%',
            boxSizing: 'border-box',
            border: 0,
            borderRadius: token.borderRadius,
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: `${token.sizeXXS}px ${token.sizeXS}px`,
          } as React.CSSProperties
        }
      >
        <span
          style={{
            display: 'grid',
            gridTemplateColumns: '34px minmax(0, 1fr) 24px',
            columnGap: token.sizeXS,
            alignItems: 'center',
          }}
        >
          <span className="agor-action-link-icon" style={{ textAlign: 'center' }}>
            {attachmentIcon(props.item, disabled)}
          </span>
          <Typography.Text ellipsis style={{ display: 'block', fontSize: 13 }}>
            {props.item.name}
          </Typography.Text>
          <PinAction {...props} />
        </span>
      </div>
    </Tooltip>
  );
}

export function SessionAttachmentDrawerRow(props: DrawerProps) {
  const { token } = theme.useToken();
  const disabledReason = sessionAttachmentDisabledReason(props.item);
  const disabled = Boolean(disabledReason);
  return (
    <div
      className="agor-action-link-row"
      role={disabled ? undefined : 'link'}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={() => props.onOpen(props.item)}
      onKeyDown={handleRowKeyDown(props.item, props.onOpen)}
      style={
        {
          '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
          '--agor-link-icon-color': disabled ? token.colorTextDisabled : token.colorTextTertiary,
          '--agor-link-row-hover-bg': token.colorFillTertiary,
          '--agor-link-row-hover-color': token.colorPrimary,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 32px 32px',
          gap: token.sizeSM,
          alignItems: 'center',
          padding: `${token.sizeSM}px ${token.sizeXS}px`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadius,
          cursor: disabled ? 'not-allowed' : 'pointer',
        } as React.CSSProperties
      }
    >
      <div style={{ display: 'flex', gap: token.sizeSM, minWidth: 0, alignItems: 'flex-start' }}>
        <span className="agor-action-link-icon">{attachmentIcon(props.item, disabled)}</span>
        <span style={{ minWidth: 0 }}>
          <Typography.Link
            className={disabled ? undefined : 'agor-action-link-title'}
            strong
            ellipsis
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpen(props.item);
            }}
            style={{ display: 'block' }}
          >
            {props.item.name}
          </Typography.Link>
          <Typography.Text type="secondary" ellipsis style={{ display: 'block', fontSize: 12 }}>
            {getSessionAttachmentTargetDisplay(props.item)}
          </Typography.Text>
          {disabledReason && (
            <Typography.Text
              type="warning"
              style={{ display: 'block', fontSize: 12, marginTop: 2 }}
            >
              {disabledReason}
            </Typography.Text>
          )}
        </span>
      </div>
      <PinAction {...props} />
      <PromotionAction {...props} />
    </div>
  );
}
