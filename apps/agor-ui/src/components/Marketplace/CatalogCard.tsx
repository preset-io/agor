/**
 * One catalog entry in the browse grid.
 *
 * The badge is `curated` and only `curated`. The row also carries a `verified`
 * boolean — a registry name match — which is deliberately not rendered: it
 * reads backwards exactly where curation was most careful, because the vendor
 * endpoints a Preset engineer hand-picked from vendor docs never appeared in
 * the registry under a matching name.
 */

import type { MCPCatalogEntry } from '@agor/core/types';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Avatar, Card, Flex, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { memo } from 'react';
import { capabilityLabel, entryTitle } from './catalogPresentation';

const { Text, Paragraph } = Typography;

export interface CatalogCardProps {
  entry: MCPCatalogEntry;
  onOpen: (entry: MCPCatalogEntry) => void;
}

const VISIBLE_CAPABILITIES = 3;

const CatalogCardInner: React.FC<CatalogCardProps> = ({ entry, onOpen }) => {
  const { token } = theme.useToken();
  const title = entryTitle(entry);
  const capabilities = entry.capabilities ?? [];
  const overflow = capabilities.length - VISIBLE_CAPABILITIES;

  return (
    <Card
      hoverable
      size="small"
      role="button"
      tabIndex={0}
      aria-label={`Open ${title}`}
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(entry);
        }
      }}
      style={{ height: '100%' }}
      styles={{ body: { height: '100%' } }}
    >
      <Flex vertical gap={token.marginXS} style={{ height: '100%' }}>
        <Flex gap={token.marginSM} align="flex-start">
          <Avatar shape="square" size={40} src={entry.icon_url} style={{ flexShrink: 0 }}>
            {title.charAt(0).toUpperCase()}
          </Avatar>
          <Flex vertical style={{ minWidth: 0, flex: 1 }}>
            <Space size={token.marginXXS} align="center">
              <Text strong ellipsis>
                {title}
              </Text>
              {entry.curated && (
                <Tooltip title="Reviewed by Preset">
                  <SafetyCertificateOutlined
                    aria-label="Reviewed by Preset"
                    style={{ color: token.colorPrimary }}
                  />
                </Tooltip>
              )}
            </Space>
            <Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
              {entry.name}
            </Text>
          </Flex>
        </Flex>

        <Paragraph
          type={entry.benefit ? undefined : 'secondary'}
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 0, minHeight: token.fontSize * 2 * token.lineHeight }}
        >
          {entry.benefit ?? entry.description ?? 'No description published.'}
        </Paragraph>

        <Space size={[token.marginXXS, token.marginXXS]} wrap>
          {capabilities.slice(0, VISIBLE_CAPABILITIES).map((capability) => (
            <Tag key={capability} style={{ marginInlineEnd: 0 }}>
              {capabilityLabel(capability)}
            </Tag>
          ))}
          {overflow > 0 && <Text type="secondary">+{overflow}</Text>}
        </Space>
      </Flex>
    </Card>
  );
};

export const CatalogCard = memo(CatalogCardInner);
