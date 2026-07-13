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
import { getLinkItemIcon, LinkCategoryGlyph } from '../Links/LinkVisual';
import {
  getLinkContentAction,
  getLinkPreviewKind,
  getLinkUnavailableReason,
  getSafeLinkContentLabel,
} from '../Links/linkContent';

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
  teammatePromotionBusyKeys?: ReadonlySet<string>;
}

interface SharedProps {
  item: SessionAttachmentItem;
  pinningKeys?: ReadonlySet<string>;
  onOpen: (item: SessionAttachmentItem) => void;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
}

interface DrawerProps extends SharedProps, SessionAttachmentTeammateActions {}

function attachmentIcon(item: SessionAttachmentItem, disabled: boolean): React.ReactNode {
  if (isFileLinkDisplayItem(item) || isKnowledgeLinkDisplayItem(item)) {
    return (
      <LinkCategoryGlyph category={item.category} disabled={disabled} variant="attachment-small" />
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
  const isPinning = props.pinningKeys?.has(props.item.linkId ?? props.item.key) ?? false;
  const ariaLabel = getLinkPinActionLabel(props.item, { available: toggleable });

  return (
    <LinkPinAction
      pinned={props.item.isPinned}
      ariaLabel={ariaLabel}
      disabled={!toggleable}
      loading={isPinning}
      onToggle={() => props.onTogglePinned?.(props.item)}
    />
  );
}

function promotionAction(props: DrawerProps) {
  const state = props.getTeammateActionState?.(props.item);
  if (!state || state.disabled) return null;
  const busyKey = props.item.linkId ?? props.item.key;
  const busy = state.loading || Boolean(props.teammatePromotionBusyKeys?.has(busyKey));
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
        <Flex component="span" align="flex-start" gap="small" style={{ minWidth: 0 }}>
          <Flex
            component="span"
            align="center"
            justify="center"
            aria-hidden="true"
            style={{ width: 28, minHeight: 28, flex: '0 0 28px' }}
          >
            {attachmentIcon(props.item, disabled)}
          </Flex>
          <Flex component="span" vertical gap={token.sizeXXS} style={{ minWidth: 0, flex: 1 }}>
            <Typography.Text strong ellipsis disabled={disabled}>
              {props.item.name}
            </Typography.Text>
            <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
              {getTargetDisplay(props.item)}
            </Typography.Text>
            {disabledReason && (
              <Typography.Text type="warning" style={{ fontSize: token.fontSizeSM }}>
                {disabledReason}
              </Typography.Text>
            )}
          </Flex>
        </Flex>
      ) : (
        <Flex component="span" align="center" gap="small" style={{ minWidth: 0 }}>
          <Flex
            component="span"
            align="center"
            justify="center"
            style={{ width: 26, flex: '0 0 auto' }}
          >
            {attachmentIcon(props.item, disabled)}
          </Flex>
          <Typography.Text
            ellipsis
            disabled={disabled}
            style={{ minWidth: 0, fontSize: token.fontSizeSM }}
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
