import { Flex, Typography, theme } from 'antd';
import type React from 'react';
import {
  ActionLinkRow,
  getLinkDisplaySecondaryLabel,
  isFileLinkDisplayItem,
  isKnowledgeLinkDisplayItem,
  LinkCollectionRow,
  type LinkDisplayItem,
  type LinkPlacementMenuItem,
  type LinkPromotionAction,
} from '../Links';
import { getLinkItemIcon, LinkCategoryGlyph } from '../Links/LinkVisual';
import {
  getLinkContentAction,
  getLinkPreviewKind,
  getLinkUnavailableReason,
  getSafeLinkContentLabel,
} from '../Links/linkContent';

type SessionAttachmentItem = LinkDisplayItem;

export interface SessionAttachmentPlacementActions {
  getPlacementItems?: (item: SessionAttachmentItem) => readonly LinkPlacementMenuItem[];
  onPlacementAction?: (
    item: SessionAttachmentItem,
    action: LinkPromotionAction
  ) => Promise<unknown>;
  onOpenPlacements?: (item: SessionAttachmentItem) => unknown | Promise<unknown>;
}

export interface SessionAttachmentLifecycleActions {
  lifecycleBusyKeys?: ReadonlySet<string>;
  onEditLink?: (item: SessionAttachmentItem) => void;
  onDeleteLink?: (item: SessionAttachmentItem) => Promise<unknown>;
  deleteLabel?: string;
}

interface SharedProps {
  item: SessionAttachmentItem;
  pinningKeys?: ReadonlySet<string>;
  onOpen: (item: SessionAttachmentItem) => void;
  onTogglePinned?: (item: SessionAttachmentItem) => void | Promise<void>;
}

interface DrawerProps
  extends SharedProps,
    SessionAttachmentPlacementActions,
    SessionAttachmentLifecycleActions {}

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

  if (drawer) {
    const busyKey = props.item.linkId ?? props.item.key;
    return (
      <LinkCollectionRow
        item={props.item}
        bordered
        secondaryLabel={getTargetDisplay(props.item)}
        placementItems={props.getPlacementItems?.(props.item)}
        pinning={props.pinningKeys?.has(busyKey) ?? false}
        lifecycleBusy={props.lifecycleBusyKeys?.has(busyKey) ?? false}
        onOpen={props.onOpen}
        onTogglePinned={props.onTogglePinned}
        onPlacementAction={props.onPlacementAction}
        onOpenPlacements={props.onOpenPlacements}
        onEdit={props.onEditLink}
        onDelete={props.onDeleteLink}
        deleteLabel={props.deleteLabel}
      />
    );
  }

  return (
    <ActionLinkRow
      compact
      disabled={disabled}
      ariaLabel={actionLabel}
      onActivate={() => props.onOpen(props.item)}
    >
      <Flex component="span" align="center" gap="small" style={{ minWidth: 0 }}>
        <Flex
          component="span"
          align="center"
          justify="center"
          style={{
            width: token.controlHeightSM,
            flex: `0 0 ${token.controlHeightSM}px`,
          }}
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
    </ActionLinkRow>
  );
}

export function SessionAttachmentQuickRow(props: SharedProps) {
  return <SessionAttachmentRow {...props} drawer={false} />;
}

export function SessionAttachmentDrawerRow(props: DrawerProps) {
  return <SessionAttachmentRow {...props} drawer />;
}
