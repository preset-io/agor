import type { Link } from '@agor-live/client';
import { Flex, List, Typography, theme } from 'antd';
import {
  ActionLinkRow,
  canPersistLinkPin,
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  getLinkPinActionLabel,
  getTeammatePromotionActionLabel,
  getTeammatePromotionState,
  type LinkDisplayItem,
  LinkOverflowAction,
  LinkPinAction,
} from '../../Links';
import { LinkCategoryGlyph } from '../../Links/LinkVisual';
import { getLinkUnavailableReason } from '../../Links/linkContent';

interface BranchLinkListItemProps {
  item: LinkDisplayItem;
  sourceSessionLabel: string | null;
  teammateBranchId?: string | null;
  teammateLinks: Link[];
  sourceBranchId: string;
  teammateBusyKeys?: ReadonlySet<string>;
  pinning: boolean;
  onOpen: (item: LinkDisplayItem) => void;
  onTogglePinned: (item: LinkDisplayItem) => void | Promise<void>;
  onPromote: (item: LinkDisplayItem) => void | Promise<void>;
  onRemove: (item: LinkDisplayItem, teammateLinkId: string) => void | Promise<void>;
}

function PromotionAction(props: BranchLinkListItemProps) {
  const state = getTeammatePromotionState({
    item: props.item,
    teammateBranchId: props.teammateBranchId,
    teammateLinks: props.teammateLinks,
    sourceBranchId: props.sourceBranchId,
  });
  if (!state.canPromote) return null;
  const busy = props.teammateBusyKeys?.has(props.item.linkId ?? props.item.key) ?? false;
  const label = getTeammatePromotionActionLabel(state);

  return (
    <LinkOverflowAction
      ariaLabel={`Teammate actions for ${getCompactLinkDisplayName(props.item)}`}
      actionLabel={label}
      tooltip="Teammate link actions"
      disabled={busy}
      loading={busy}
      onAction={() => {
        if (state.isPromoted && state.teammateLink) {
          return props.onRemove(props.item, state.teammateLink.link_id);
        }
        return props.onPromote(props.item);
      }}
    />
  );
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
            <PromotionAction {...props} />
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
