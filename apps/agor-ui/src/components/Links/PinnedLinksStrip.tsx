import { LinkOutlined, PushpinFilled } from '@ant-design/icons';
import { Space, Tag, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { LinkDisplayTargetLink } from './LinkDisplayTargetLink';
import {
  getCompactLinkDisplayName,
  getLinkDisplayPillLabel,
  type LinkDisplayItem,
} from './linkDisplay';

interface PinnedLinksStripProps {
  items: LinkDisplayItem[];
  maxItems?: number;
  compact?: boolean;
  label?: string;
}

export const PinnedLinksStrip: React.FC<PinnedLinksStripProps> = ({
  items,
  maxItems = 4,
  compact = false,
  label = 'Pinned links',
}) => {
  const { token } = theme.useToken();
  const visibleItems = items.slice(0, maxItems);
  if (visibleItems.length === 0) return null;

  return (
    <div style={{ marginTop: compact ? 6 : 8, marginBottom: compact ? 6 : 8 }}>
      <Space size={4} wrap>
        <Typography.Text type="secondary" style={{ fontSize: compact ? 11 : 12 }}>
          <PushpinFilled style={{ color: token.colorPrimary }} /> {label}
        </Typography.Text>
        {visibleItems.map((item) => {
          const name = getCompactLinkDisplayName(item);
          const chip = (
            <Tag
              key={item.key}
              icon={<LinkOutlined />}
              color="blue"
              style={{
                maxWidth: compact ? 150 : 220,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {name}
            </Tag>
          );
          return item.href ? (
            <LinkDisplayTargetLink
              key={item.key}
              item={item}
              onClick={(event) => event.stopPropagation()}
            >
              <Tooltip title={`${getLinkDisplayPillLabel(item.category)}: ${name}`}>{chip}</Tooltip>
            </LinkDisplayTargetLink>
          ) : (
            <Tooltip key={item.key} title={`${getLinkDisplayPillLabel(item.category)}: ${name}`}>
              {chip}
            </Tooltip>
          );
        })}
        {items.length > visibleItems.length && <Tag>+{items.length - visibleItems.length}</Tag>}
      </Space>
    </div>
  );
};

export default PinnedLinksStrip;
