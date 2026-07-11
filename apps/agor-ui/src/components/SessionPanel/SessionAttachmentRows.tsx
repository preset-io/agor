import { Flex, Typography, theme } from 'antd';
import type React from 'react';
import {
  ActionLinkRow,
  canPersistLinkPin,
  getLinkDisplaySecondaryLabel,
  getLinkPinActionLabel,
  isFileLinkDisplayItem,
  isKnowledgeLinkDisplayItem,
  type LinkDisplayItem,
  LinkOverflowAction,
  LinkPinAction,
} from '../Links';
import { LinkAttachmentGlyph } from '../Links/LinkAttachmentCard';
import { getLinkItemIcon } from '../Links/LinkVisual';
import {
  getLinkContentAction,
  getLinkPreviewKind,
  getLinkUnavailableReason,
  getSafeLinkContentLabel,
} from '../Links/linkContent';
import styles from '../Links/linkUi.module.css';

type SessionAttachmentItem = LinkDisplayItem;

export interface SessionAttachmentTeammateState {
  isPromoted: boolean;
  teammateLinkId?: string;
  disabled?: boolean;
  loading?: boolean;
  unavailableReason?: string | null;
}

export interface SessionAttachmentTeammateActions {
  getTeammateActionState?: (item: SessionAttachmentItem) => SessionAttachmentTeammateState | null;
  onPromoteToTeammate?: (item: SessionAttachmentItem) => void | Promise<void>;
  onRemoveFromTeammate?: (
    item: SessionAttachmentItem,
    teammateLinkId: string
  ) => void | Promise<void>;
  teammatePromotionBusyKey?: string | null;
}

interface SharedProps {
  item: SessionAttachmentItem;
  pinningLinkId?: string | null;
  onOpen: (item: SessionAttachmentItem) => void;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
}

interface DrawerProps extends SharedProps, SessionAttachmentTeammateActions {}

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

function getTargetDisplay(item: SessionAttachmentItem): string {
  if (item.filePath) return getSafeLinkContentLabel(item.filePath) || 'Uploaded file';
  return getLinkDisplaySecondaryLabel(item) || 'No target';
}

function pinAction(props: SharedProps) {
  const toggleable = canPersistLinkPin(props.item) && Boolean(props.onTogglePinned);
  const isPinning = props.pinningLinkId === (props.item.linkId ?? props.item.key);
  const label = toggleable
    ? getLinkPinActionLabel(props.item, 'session header')
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
  if (!state || state.disabled) return null;
  const busyKey = state.teammateLinkId ?? props.item.linkId ?? props.item.key;
  const busy = state.loading || props.teammatePromotionBusyKey === busyKey;
  const disabled = busy || (state.isPromoted && !state.teammateLinkId);
  const label = state.isPromoted ? 'Remove from teammate' : 'Promote to teammate';

  return (
    <LinkOverflowAction
      ariaLabel={`Teammate actions for ${props.item.name}`}
      actionLabel={label}
      tooltip="Teammate link actions"
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

function SessionAttachmentRow({ drawer, ...props }: DrawerProps & { drawer: boolean }) {
  const { token } = theme.useToken();
  const disabledReason = getLinkUnavailableReason(props.item);
  const disabled = Boolean(disabledReason);
  const previewKind = getLinkPreviewKind(props.item);
  const contentAction = getLinkContentAction(props.item);
  const actionLabel =
    disabledReason ??
    (previewKind === 'image'
      ? `Preview image ${props.item.name}`
      : contentAction === 'download'
        ? `Download file ${props.item.name}`
        : `Open link ${props.item.name}`);

  const row = (
    <ActionLinkRow
      bordered={drawer}
      compact={!drawer}
      disabled={disabled}
      ariaLabel={drawer && disabledReason ? `${props.item.name}: ${disabledReason}` : actionLabel}
      onActivate={() => props.onOpen(props.item)}
      actions={
        <>
          {pinAction(props)}
          {drawer && promotionAction(props)}
        </>
      }
    >
      {drawer ? (
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
            <Typography.Text className={styles.smallText} type="secondary" ellipsis>
              {getTargetDisplay(props.item)}
            </Typography.Text>
            {disabledReason && (
              <Typography.Text className={styles.smallText} type="warning">
                {disabledReason}
              </Typography.Text>
            )}
          </Flex>
        </Flex>
      ) : (
        <Flex component="span" align="center" gap="small" className={styles.minWidthZero}>
          <Flex component="span" className={styles.quickGlyph} align="center" justify="center">
            {attachmentIcon(props.item, disabled)}
          </Flex>
          <Typography.Text
            ellipsis
            disabled={disabled}
            className={`${styles.minWidthZero} ${styles.smallText}`}
          >
            {props.item.name}
          </Typography.Text>
        </Flex>
      )}
    </ActionLinkRow>
  );

  return row;
}

export function SessionAttachmentQuickRow(props: SharedProps) {
  return <SessionAttachmentRow {...props} drawer={false} />;
}

export function SessionAttachmentDrawerRow(props: DrawerProps) {
  return <SessionAttachmentRow {...props} drawer />;
}
