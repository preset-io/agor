import { GithubOutlined, GlobalOutlined, LinkOutlined, StopOutlined } from '@ant-design/icons';
import { Flex, Tooltip, Typography } from 'antd';
import type React from 'react';
import {
  ActionLinkRow,
  isFileLinkDisplayItem,
  isKnowledgeLinkDisplayItem,
  LinkOverflowAction,
  LinkPinAction,
} from '../Links';
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

function canTogglePinned(
  item: SessionAttachmentItem,
  onTogglePinned?: SharedProps['onTogglePinned']
) {
  return item.ownerScope === 'session' && Boolean(item.linkId) && Boolean(onTogglePinned);
}

function pinAction(props: SharedProps) {
  const toggleable = canTogglePinned(props.item, props.onTogglePinned);
  const isPinning = Boolean(props.item.linkId && props.pinningLinkId === props.item.linkId);
  const label = toggleable
    ? props.item.isPinned
      ? 'Unpin from session header'
      : 'Pin in session'
    : props.item.ownerScope === 'branch'
      ? 'Pin is read-only here'
      : 'Pin unavailable';

  return (
    <LinkPinAction
      pinned={props.item.isPinned}
      label={label}
      disabled={!toggleable}
      loading={isPinning}
      onToggle={() => props.onTogglePinned?.(props.item)}
    />
  );
}

function promotionAction(props: DrawerProps) {
  const state = props.getTeammateActionState?.(props.item);
  if (!state) return null;
  const busyKey = state.teammateLinkId ?? props.item.linkId ?? props.item.key;
  const busy = state.loading || props.teammatePromotionBusyKey === busyKey;
  const disabled = state.disabled || busy || (state.isPromoted && !state.teammateLinkId);
  const label = state.isPromoted ? 'Remove from teammate' : 'Promote to teammate';

  return (
    <LinkOverflowAction
      ariaLabel={`Teammate actions for ${props.item.name}`}
      actionLabel={label}
      tooltip={state.unavailableReason ?? 'Teammate link actions'}
      disabled={disabled}
      loading={busy}
      onAction={() => {
        if (state.isPromoted && state.teammateLinkId) {
          return props.onRemoveFromTeammate?.(props.item, state.teammateLinkId);
        }
        return props.onPromoteToTeammate?.(props.item);
      }}
    />
  );
}

export function SessionAttachmentQuickRow(props: SharedProps) {
  const disabledReason = sessionAttachmentDisabledReason(props.item);
  const disabled = Boolean(disabledReason);
  const actionLabel =
    disabledReason ??
    (canPreviewSessionImage(props.item)
      ? `Preview image ${props.item.name}`
      : canDownloadSessionFile(props.item)
        ? `Download file ${props.item.name}`
        : `Open link ${props.item.name}`);

  return (
    <Tooltip title={actionLabel} placement="left">
      <div>
        <ActionLinkRow
          compact
          disabled={disabled}
          ariaLabel={actionLabel}
          onActivate={() => props.onOpen(props.item)}
          actions={pinAction(props)}
        >
          <Flex align="center" gap="small" style={{ minWidth: 0 }}>
            <Flex align="center" justify="center" style={{ width: 26, flex: '0 0 auto' }}>
              {attachmentIcon(props.item, disabled)}
            </Flex>
            <Typography.Text ellipsis disabled={disabled} style={{ fontSize: 13, minWidth: 0 }}>
              {props.item.name}
            </Typography.Text>
          </Flex>
        </ActionLinkRow>
      </div>
    </Tooltip>
  );
}

export function SessionAttachmentDrawerRow(props: DrawerProps) {
  const disabledReason = sessionAttachmentDisabledReason(props.item);
  const disabled = Boolean(disabledReason);

  return (
    <ActionLinkRow
      bordered
      disabled={disabled}
      ariaLabel={
        disabledReason ? `${props.item.name}: ${disabledReason}` : `Open ${props.item.name}`
      }
      onActivate={() => props.onOpen(props.item)}
      actions={
        <>
          {pinAction(props)}
          {promotionAction(props)}
        </>
      }
    >
      <Flex align="flex-start" gap="small" style={{ minWidth: 0 }}>
        <span aria-hidden="true">{attachmentIcon(props.item, disabled)}</span>
        <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong ellipsis disabled={disabled}>
            {props.item.name}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
            {getSessionAttachmentTargetDisplay(props.item)}
          </Typography.Text>
          {disabledReason && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {disabledReason}
            </Typography.Text>
          )}
        </Flex>
      </Flex>
    </ActionLinkRow>
  );
}
