import type { Link } from '@agor-live/client';
import { Flex, List, Typography, theme } from 'antd';
import {
  ActionLinkRow,
  getCompactLinkDisplayName,
  getLinkDisplaySecondaryLabel,
  getTeammatePromotionActionLabel,
  getTeammatePromotionState,
  type LinkDisplayItem,
  LinkOverflowAction,
  LinkPinAction,
} from '../../Links';
import { getLinkCompactGlyph } from '../../Links/LinkVisual';
import { getLinkUnavailableReason } from '../../Links/linkContent';
import styles from '../../Links/linkUi.module.css';

interface BranchLinkListItemProps {
  item: LinkDisplayItem;
  sourceSessionLabel: string | null;
  teammateBranchId?: string | null;
  teammateLinks: Link[];
  sourceBranchId: string;
  teammateBusyKey?: string | null;
  pinning: boolean;
  onOpen: (item: LinkDisplayItem) => void;
  onTogglePinned: (item: LinkDisplayItem) => void | Promise<void>;
  onPromote: (item: LinkDisplayItem) => void | Promise<void>;
  onRemove: (item: LinkDisplayItem, teammateLinkId: string) => void | Promise<void>;
}

function BranchGlyph({ item, disabled }: { item: LinkDisplayItem; disabled: boolean }) {
  const { token } = theme.useToken();
  return (
    <Flex
      className={`${styles.glyph} ${styles.branchGlyph}`}
      align="center"
      justify="center"
      aria-hidden="true"
      style={{
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        color: disabled ? token.colorTextDisabled : token.colorTextTertiary,
      }}
    >
      {getLinkCompactGlyph(item.category, disabled)}
    </Flex>
  );
}

function PromotionAction(props: BranchLinkListItemProps) {
  const state = getTeammatePromotionState({
    item: props.item,
    teammateBranchId: props.teammateBranchId,
    teammateLinks: props.teammateLinks,
    sourceBranchId: props.sourceBranchId,
  });
  const busy =
    props.teammateBusyKey === (state.teammateLink?.link_id ?? props.item.linkId ?? props.item.key);
  const label = getTeammatePromotionActionLabel(state);

  return (
    <LinkOverflowAction
      ariaLabel={`Teammate actions for ${getCompactLinkDisplayName(props.item)}`}
      actionLabel={label}
      tooltip={state.canPromote ? 'Teammate link actions' : label}
      disabled={!state.canPromote || busy}
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
  const pinLabel = props.item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';

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
              label={`${pinLabel} ${title}`}
              disabled={!props.item.linkId}
              loading={props.pinning}
              onToggle={() => props.onTogglePinned(props.item)}
            />
            <PromotionAction {...props} />
          </>
        }
      >
        <Flex align="flex-start" gap="small" className={styles.minWidthZero}>
          <BranchGlyph item={props.item} disabled={disabled} />
          <Flex vertical gap={token.sizeXXS} className={styles.rowContent}>
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
