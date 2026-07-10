import type { Link } from '@agor-live/client';
import {
  EllipsisOutlined,
  GithubOutlined,
  PushpinFilled,
  PushpinOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, List, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  getCompactLinkDisplayName,
  getLinkDisplayGlyphLabel,
  getLinkDisplaySecondaryLabel,
  getTeammatePromotionState,
  isFileLinkDisplayItem,
  type LinkDisplayItem,
} from '../../Links';
import { getLinkContentAction } from '../../Links/linkContent';

interface BranchLinkListItemProps {
  item: LinkDisplayItem;
  sourceSessionLabel: string | null;
  teammateBranchId?: string | null;
  teammateLinks: Link[];
  sourceBranchId: string;
  teammateBusyKey?: string | null;
  pinning: boolean;
  onOpen: (item: LinkDisplayItem) => void;
  onPreview: (item: LinkDisplayItem) => void;
  onDownload: (item: LinkDisplayItem) => void;
  onTogglePinned: (item: LinkDisplayItem) => void | Promise<void>;
  onPromote: (item: LinkDisplayItem) => void | Promise<void>;
  onRemove: (item: LinkDisplayItem, teammateLinkId: string) => void | Promise<void>;
}

function unavailableReason(item: LinkDisplayItem): string | null {
  if (item.href || getLinkContentAction(item)) return null;
  return isFileLinkDisplayItem(item)
    ? 'No preview/download route is available yet.'
    : 'No safe route is available for this item yet.';
}

function shouldIgnoreActivation(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('a,button,[role="button"]'));
}

function BranchGlyph({ item, disabled }: { item: LinkDisplayItem; disabled: boolean }) {
  const { token } = theme.useToken();
  const isGitHubLink = item.category === 'issue' || item.category === 'pr';
  return (
    <span
      className="agor-action-link-icon"
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: token.borderRadiusLG,
        background: token.colorFillTertiary,
        color: disabled
          ? token.colorTextDisabled
          : `var(--agor-link-icon-color, ${token.colorTextTertiary})`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
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
    </span>
  );
}

function BranchTitle({
  item,
  disabled,
  onPreview,
  onDownload,
}: {
  item: LinkDisplayItem;
  disabled: boolean;
  onPreview: (item: LinkDisplayItem) => void;
  onDownload: (item: LinkDisplayItem) => void;
}) {
  const { token } = theme.useToken();
  const title = getCompactLinkDisplayName(item);
  const contentAction = getLinkContentAction(item);
  const style: React.CSSProperties = {
    color: disabled ? token.colorTextDisabled : `var(--agor-link-title-color, ${token.colorText})`,
    fontWeight: 600,
    lineHeight: 1.25,
  };

  if (item.href && item.navigation === 'spa') {
    return (
      <RouterLink
        className="agor-action-link-title"
        to={item.href}
        style={{ ...style, textDecoration: 'none' }}
        title={title}
      >
        {title}
      </RouterLink>
    );
  }
  if (item.href) {
    return (
      <a
        className="agor-action-link-title"
        href={item.href}
        target="_blank"
        rel="noreferrer"
        style={{ ...style, textDecoration: 'none' }}
        title={title}
      >
        {title}
      </a>
    );
  }
  if (contentAction) {
    return (
      <button
        className="agor-action-link-title"
        type="button"
        onClick={() => (contentAction === 'preview' ? onPreview(item) : onDownload(item))}
        style={{
          ...style,
          border: 0,
          background: 'transparent',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
        title={title}
      >
        {title}
      </button>
    );
  }
  return (
    <Typography.Text disabled style={style} title={title}>
      {title}
    </Typography.Text>
  );
}

function PinAction({
  item,
  pinning,
  onToggle,
}: {
  item: LinkDisplayItem;
  pinning: boolean;
  onToggle: (item: LinkDisplayItem) => void | Promise<void>;
}) {
  const { token } = theme.useToken();
  const canToggle = Boolean(item.linkId);
  const label = item.isPinned ? 'Unpin from branch card' : 'Pin to branch card';
  return (
    <Tooltip title={label}>
      <button
        type="button"
        disabled={!canToggle || pinning}
        aria-label={`${label} ${getCompactLinkDisplayName(item)}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onToggle(item);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          padding: 0,
          border: 0,
          borderRadius: token.borderRadiusSM,
          background: item.isPinned ? token.colorWarningBg : token.colorFillTertiary,
          color: item.isPinned ? token.colorWarning : token.colorTextSecondary,
          cursor: canToggle && !pinning ? 'pointer' : 'default',
          opacity: pinning ? 0.55 : 1,
        }}
      >
        {item.isPinned ? <PushpinFilled /> : <PushpinOutlined />}
      </button>
    </Tooltip>
  );
}

function promotionLabel(state: ReturnType<typeof getTeammatePromotionState>): string {
  if (state.canPromote) return state.isPromoted ? 'Remove from teammate' : 'Promote to teammate';
  if (state.reason === 'no-teammate') return 'No teammate configured';
  if (state.reason === 'same-owner') return 'Already on teammate branch';
  if (state.reason === 'missing-source-link') return 'Cannot add generated branch metadata';
  if (state.reason === 'file-lifetime') return 'File promotion awaits upload retention support';
  if (state.reason === 'internal-target-access')
    return 'Internal promotion awaits target access checks';
  return 'Cannot add this link';
}

function PromotionAction(props: BranchLinkListItemProps) {
  const { token } = theme.useToken();
  const state = getTeammatePromotionState({
    item: props.item,
    teammateBranchId: props.teammateBranchId,
    teammateLinks: props.teammateLinks,
    sourceBranchId: props.sourceBranchId,
  });
  const busy =
    props.teammateBusyKey === (state.teammateLink?.link_id ?? props.item.linkId ?? props.item.key);
  const label = promotionLabel(state);
  return (
    <Tooltip title={state.canPromote ? 'Teammate link actions' : label}>
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            {
              key: state.isPromoted ? 'remove-teammate' : 'promote-teammate',
              label,
              disabled: !state.canPromote || busy,
            },
          ],
          onClick: ({ domEvent }) => {
            domEvent.preventDefault();
            domEvent.stopPropagation();
            if (!state.canPromote || busy) return;
            if (state.isPromoted && state.teammateLink) {
              void props.onRemove(props.item, state.teammateLink.link_id);
            } else {
              void props.onPromote(props.item);
            }
          },
        }}
      >
        <Button
          type="text"
          size="small"
          loading={busy}
          aria-label={`Teammate actions for ${getCompactLinkDisplayName(props.item)}`}
          icon={<EllipsisOutlined />}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
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

export function BranchLinkListItem(props: BranchLinkListItemProps) {
  const { token } = theme.useToken();
  const disabledReason = unavailableReason(props.item);
  const disabled = Boolean(disabledReason);
  const targetLabel = getLinkDisplaySecondaryLabel(props.item);
  const activate = () => {
    if (!disabled) props.onOpen(props.item);
  };

  return (
    <List.Item
      className="agor-action-link-row"
      role={disabled ? undefined : 'link'}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (!shouldIgnoreActivation(event.target)) activate();
      }}
      onKeyDown={(event) => {
        if (shouldIgnoreActivation(event.target) || (event.key !== 'Enter' && event.key !== ' '))
          return;
        event.preventDefault();
        activate();
      }}
      style={
        {
          '--agor-link-title-color': disabled ? token.colorTextDisabled : token.colorText,
          '--agor-link-icon-color': disabled ? token.colorTextDisabled : token.colorTextTertiary,
          '--agor-link-row-hover-bg': token.colorFillTertiary,
          '--agor-link-row-hover-color': token.colorPrimary,
          borderColor: token.colorBorderSecondary,
          borderRadius: token.borderRadius,
          cursor: disabled ? 'default' : 'pointer',
          paddingRight: token.sizeSM,
        } as React.CSSProperties
      }
      actions={[
        <PinAction
          key="state"
          item={props.item}
          pinning={props.pinning}
          onToggle={props.onTogglePinned}
        />,
        <PromotionAction key="teammate" {...props} />,
      ]}
    >
      <List.Item.Meta
        avatar={<BranchGlyph item={props.item} disabled={disabled} />}
        title={
          <BranchTitle
            item={props.item}
            disabled={disabled}
            onPreview={props.onPreview}
            onDownload={props.onDownload}
          />
        }
        description={
          <span>
            {targetLabel && (
              <Typography.Text type="secondary" ellipsis style={{ display: 'block' }}>
                {targetLabel}
              </Typography.Text>
            )}
            {props.sourceSessionLabel && (
              <Typography.Text
                type="secondary"
                ellipsis
                style={{ display: 'block', fontSize: 12, marginTop: 2 }}
              >
                From {props.sourceSessionLabel}
              </Typography.Text>
            )}
            {disabledReason && (
              <Typography.Text
                type="warning"
                style={{ display: 'block', fontSize: 12, marginTop: 2 }}
              >
                {disabledReason}
              </Typography.Text>
            )}
          </span>
        }
      />
    </List.Item>
  );
}
