import { Flex, List, Typography, theme } from 'antd';
import {
  ActionLinkRow,
  canPersistLinkPin,
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  getLinkPinActionLabel,
  LinkActionsMenu,
  type LinkDisplayItem,
  type LinkMoveAction,
  type LinkMoveSelection,
  LinkPinAction,
} from '../../Links';
import { LinkCategoryGlyph } from '../../Links/LinkVisual';
import { getLinkUnavailableReason } from '../../Links/linkContent';

interface BranchLinkListItemProps {
  item: LinkDisplayItem;
  sourceSessionLabel: string | null;
  moveActions: readonly LinkMoveAction[];
  pinning: boolean;
  lifecycleBusy: boolean;
  onOpen: (item: LinkDisplayItem) => void;
  onTogglePinned: (item: LinkDisplayItem) => void | Promise<void>;
  onMove: (item: LinkDisplayItem, selection: LinkMoveSelection) => Promise<unknown>;
  onEdit: (item: LinkDisplayItem) => void;
  onDelete: (item: LinkDisplayItem) => Promise<unknown>;
}

export function BranchLinkListItem(props: BranchLinkListItemProps) {
  const { token } = theme.useToken();
  const disabledReason = getLinkUnavailableReason(props.item);
  const disabled = Boolean(disabledReason);
  const title = getCompactLinkDisplayName(props.item);
  const targetLabel = getLinkDisplaySecondaryLabel(props.item);

  return (
    <List.Item style={{ paddingBlock: 0 }}>
      <ActionLinkRow
        disabled={disabled}
        ariaLabel={disabledReason ? `${title}: ${disabledReason}` : `Open ${title}`}
        href={props.item.href}
        navigation={props.item.navigation}
        onActivate={props.item.href ? undefined : () => props.onOpen(props.item)}
        actions={
          <>
            <LinkPinAction
              pinned={props.item.isPinned}
              ariaLabel={getLinkPinActionLabel(props.item)}
              disabled={!canPersistLinkPin(props.item)}
              loading={props.pinning}
              onToggle={() => props.onTogglePinned(props.item)}
            />
            <LinkActionsMenu
              item={props.item}
              busy={props.lifecycleBusy}
              onEdit={() => props.onEdit(props.item)}
              onDelete={props.item.linkId ? () => props.onDelete(props.item) : undefined}
              moveActions={props.moveActions}
              onMove={(selection) => props.onMove(props.item, selection)}
            />
          </>
        }
      >
        <Flex component="span" align="flex-start" gap="small" style={{ minWidth: 0 }}>
          <LinkCategoryGlyph category={props.item.category} disabled={disabled} variant="row" />
          <Flex component="span" vertical gap={token.sizeXXS} style={{ minWidth: 0, flex: 1 }}>
            <Typography.Text strong ellipsis disabled={disabled} style={{ lineHeight: 1.25 }}>
              {title}
            </Typography.Text>
            {targetLabel && (
              <Typography.Text type="secondary" ellipsis>
                {targetLabel}
              </Typography.Text>
            )}
            {props.sourceSessionLabel && (
              <Typography.Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
                From {props.sourceSessionLabel}
              </Typography.Text>
            )}
            {disabledReason && (
              <Typography.Text type="warning" style={{ fontSize: token.fontSizeSM }}>
                {disabledReason}
              </Typography.Text>
            )}
          </Flex>
        </Flex>
      </ActionLinkRow>
    </List.Item>
  );
}
