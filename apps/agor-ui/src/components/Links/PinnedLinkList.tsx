import { PushpinFilled, SettingOutlined } from '@ant-design/icons';
import { Button, Flex, Space, Spin, Tooltip, Typography, theme } from 'antd';
import { useMemo } from 'react';
import type { LinkDisplayItem } from './linkDisplay';
import { LINK_MANAGER_COPY } from './linkUiConstants';
import { LinkPreviewModal, LinkRow, useLinkFileActions } from './SessionLinksControl';

interface PinnedLinkListProps {
  items: LinkDisplayItem[];
  loading?: boolean;
  error?: string | null;
  onTogglePinned?: (item: LinkDisplayItem) => void | Promise<void>;
  pinningKeys?: ReadonlySet<string>;
  onOpenMore?: () => void;
  onManage?: () => void;
  countMode?: 'hidden' | 'total';
  loadingLabel?: string;
  className?: string;
  'data-testid'?: string;
}

const INLINE_LIMIT = 6;

export function PinnedLinkList({
  items,
  loading = false,
  error = null,
  onTogglePinned,
  pinningKeys,
  onOpenMore,
  onManage,
  countMode = 'hidden',
  loadingLabel = 'Loading links…',
  className,
  'data-testid': dataTestId,
}: PinnedLinkListProps) {
  const { token } = theme.useToken();
  const { preview, setPreview, openPreview, downloadItem } = useLinkFileActions();
  const pinnedItems = useMemo(() => items.filter((item) => item.isPinned), [items]);
  const inlineItems = pinnedItems.slice(0, INLINE_LIMIT);
  const hiddenCount = pinnedItems.length - inlineItems.length;

  if (!loading && !error && pinnedItems.length === 0) return null;

  return (
    <>
      <Flex
        vertical
        className={className}
        data-testid={dataTestId}
        style={{
          marginBlock: `${token.marginXXS}px ${token.marginMD}px`,
          paddingBlock: `${token.paddingXXS}px ${token.paddingSM}px`,
          borderBottom: `1px dashed ${token.colorBorderSecondary}`,
        }}
      >
        <Flex
          align="center"
          justify="space-between"
          gap="small"
          style={{ marginBottom: token.marginXS }}
        >
          <Flex align="center" gap="small">
            <PushpinFilled style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }} />
            <Typography.Text type="secondary" strong style={{ fontSize: token.fontSizeSM }}>
              {LINK_MANAGER_COPY.pinnedTitle}
            </Typography.Text>
            {pinnedItems.length > 0 && countMode === 'total' && (
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {pinnedItems.length}
              </Typography.Text>
            )}
            {hiddenCount > 0 && countMode === 'hidden' && (
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                +{hiddenCount} more
              </Typography.Text>
            )}
          </Flex>
          <Flex align="center" gap="small">
            {loading && <Spin size="small" />}
            {onManage && (
              <Tooltip title={LINK_MANAGER_COPY.managePinnedTooltip}>
                <Button
                  type="text"
                  size="small"
                  aria-label={LINK_MANAGER_COPY.managePinnedTooltip}
                  icon={<SettingOutlined />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onManage();
                  }}
                />
              </Tooltip>
            )}
          </Flex>
        </Flex>

        {error ? (
          <Typography.Text type="danger" style={{ fontSize: token.fontSizeSM }}>
            {error}
          </Typography.Text>
        ) : inlineItems.length > 0 ? (
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            {inlineItems.map((item) => (
              <LinkRow
                key={item.key}
                item={item}
                compact
                onPreview={openPreview}
                onDownload={downloadItem}
                onTogglePinned={onTogglePinned}
                pinning={pinningKeys?.has(item.linkId ?? item.key) ?? false}
              />
            ))}
            {hiddenCount > 0 && onOpenMore && (
              <Button type="link" size="small" onClick={onOpenMore}>
                +{hiddenCount} more
              </Button>
            )}
          </Space>
        ) : loading ? (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {loadingLabel}
          </Typography.Text>
        ) : null}
      </Flex>
      <LinkPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}
