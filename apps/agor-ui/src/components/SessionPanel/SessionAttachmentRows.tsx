import { Flex, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import {
  ActionLinkRow,
  canPersistLinkPin,
  isFileLinkDisplayItem,
  isKnowledgeLinkDisplayItem,
  LinkOverflowAction,
  LinkPinAction,
} from '../Links';
import { LinkAttachmentGlyph } from '../Links/LinkAttachmentCard';
import { getLinkItemIcon } from '../Links/LinkVisual';
import styles from '../Links/linkUi.module.css';
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
  return getLinkItemIcon(item, disabled);
}

function canTogglePinned(
  item: SessionAttachmentItem,
  onTogglePinned?: SharedProps['onTogglePinned']
) {
  return canPersistLinkPin(item) && Boolean(onTogglePinned);
}

function pinAction(props: SharedProps) {
  const toggleable = canTogglePinned(props.item, props.onTogglePinned);
  const isPinning = props.pinningLinkId === (props.item.linkId ?? props.item.key);
  const label = toggleable
    ? props.item.isPinned
      ? props.item.ownerScope === 'branch'
        ? 'Unpin from branch card'
        : 'Unpin from session header'
      : props.item.ownerScope === 'branch'
        ? 'Pin to branch card'
        : 'Pin in session'
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
  const actionLabel = disabled && state.unavailableReason ? state.unavailableReason : label;

  return (
    <LinkOverflowAction
      ariaLabel={`Teammate actions for ${props.item.name}`}
      actionLabel={actionLabel}
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
  const { token } = theme.useToken();
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
          <Flex component="span" align="center" gap="small" className={styles.minWidthZero}>
            <Flex component="span" className={styles.quickGlyph} align="center" justify="center">
              {attachmentIcon(props.item, disabled)}
            </Flex>
            <Typography.Text
              className={styles.minWidthZero}
              ellipsis
              disabled={disabled}
              style={{ fontSize: token.fontSizeSM }}
            >
              {props.item.name}
            </Typography.Text>
          </Flex>
        </ActionLinkRow>
      </div>
    </Tooltip>
  );
}

export function SessionAttachmentDrawerRow(props: DrawerProps) {
  const { token } = theme.useToken();
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
      <Flex component="span" align="flex-start" gap="small" className={styles.minWidthZero}>
        <Flex
          component="span"
          className={styles.drawerGlyph}
          align="center"
          justify="center"
          aria-hidden="true"
        >
          {attachmentIcon(props.item, disabled)}
        </Flex>
        <Flex component="span" vertical gap={token.sizeXXS} className={styles.rowContent}>
          <Typography.Text strong ellipsis disabled={disabled}>
            {props.item.name}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
            {getSessionAttachmentTargetDisplay(props.item)}
          </Typography.Text>
          {disabledReason && (
            <Typography.Text type="warning" style={{ fontSize: token.fontSizeSM }}>
              {disabledReason}
            </Typography.Text>
          )}
        </Flex>
      </Flex>
    </ActionLinkRow>
  );
}
