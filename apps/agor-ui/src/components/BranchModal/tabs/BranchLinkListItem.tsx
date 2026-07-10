import type { Link } from '@agor-live/client';
import { GithubOutlined, StopOutlined } from '@ant-design/icons';
import { Flex, List, Typography, theme } from 'antd';
import {
  ActionLinkRow,
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  getTeammatePromotionActionLabel,
  getTeammatePromotionState,
  type LinkDisplayItem,
  LinkOverflowAction,
  LinkPinAction,
} from '../../Links';
import { getLinkUnavailableReason } from '../../Links/linkContent';

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
  const isGitHubLink = item.category === 'issue' || item.category === 'pr';
  return (
    <Flex
      align="center"
      justify="center"
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        color: disabled ? token.colorTextDisabled : token.colorTextTertiary,
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 0.2,
        flex: '0 0 auto',
      }}
    >
      {disabled ? (
        <StopOutlined style={{ fontSize: 13 }} />
      ) : isGitHubLink ? (
        <GithubOutlined style={{ fontSize: 13 }} />
      ) : (
        getLinkDisplayGlyphLabel(item.category)
      )}
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
        onActivate={() => props.onOpen(props.item)}
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
        <Flex align="flex-start" gap="small" style={{ minWidth: 0 }}>
          <BranchGlyph item={props.item} disabled={disabled} />
          <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Typography.Text strong ellipsis disabled={disabled} style={{ lineHeight: 1.25 }}>
              {title}
            </Typography.Text>
            {targetLabel && (
              <Typography.Text type="secondary" ellipsis>
                {targetLabel}
              </Typography.Text>
            )}
            {props.sourceSessionLabel && (
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                From {props.sourceSessionLabel}
              </Typography.Text>
            )}
            {disabledReason && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                {disabledReason}
              </Typography.Text>
            )}
          </Flex>
        </Flex>
      </ActionLinkRow>
    </List.Item>
  );
}
