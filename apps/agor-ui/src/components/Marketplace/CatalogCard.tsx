/**
 * One catalog entry in the browse grid.
 *
 * The card carries no trust badge. Every entry on the shelf is hand-reviewed
 * and shipped in the same file, so a mark saying so would be on every row —
 * telling a user nothing they could act on and drawing the eye away from the
 * one status that does differ between rows, which is whether Connect will get
 * anywhere.
 */

import type { MCPCatalogEntry } from '@agor/core/types';
import {
  CheckCircleOutlined,
  KeyOutlined,
  LockOutlined,
  LoginOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { Card, Flex, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { memo } from 'react';
import { CatalogEntryAvatar } from './CatalogEntryAvatar';
import { capabilityLabel, connectStatus, entryTitle } from './catalogPresentation';

const { Text, Paragraph } = Typography;

export interface CatalogCardProps {
  entry: MCPCatalogEntry;
  onOpen: (entry: MCPCatalogEntry) => void;
}

const VISIBLE_CAPABILITIES = 3;

const CatalogCardInner: React.FC<CatalogCardProps> = ({ entry, onOpen }) => {
  const { token } = theme.useToken();
  const title = entryTitle(entry);
  const capabilities = entry.capabilities;
  const overflow = capabilities.length - VISIBLE_CAPABILITIES;
  // Whether pressing Connect will get anywhere, on the card rather than after
  // the disclosure — most curated entries want an account the marketplace has
  // no way to ask for, so discovering it at the button is discovering it late.
  const connect = connectStatus(entry);

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
          <CatalogEntryAvatar iconUrl={entry.icon_url} title={title} style={{ flexShrink: 0 }} />
          <Flex vertical style={{ minWidth: 0, flex: 1 }}>
            <Text strong ellipsis>
              {title}
            </Text>
            <Text type="secondary" ellipsis style={{ fontSize: token.fontSizeSM }}>
              {entry.name}
            </Text>
          </Flex>
        </Flex>

        <Paragraph
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 0, minHeight: token.fontSize * 2 * token.lineHeight }}
        >
          {entry.benefit}
        </Paragraph>

        <Space size={[token.marginXXS, token.marginXXS]} wrap>
          {capabilities.slice(0, VISIBLE_CAPABILITIES).map((capability) => (
            <Tag key={capability} style={{ marginInlineEnd: 0 }}>
              {capabilityLabel(capability)}
            </Tag>
          ))}
          {overflow > 0 && <Text type="secondary">+{overflow}</Text>}
        </Space>

        <Tooltip title={connect.detail}>
          <Space size={token.marginXXS} align="center">
            {connect.readiness === 'ready' ? (
              <CheckCircleOutlined style={{ color: token.colorSuccess }} />
            ) : connect.readiness === 'sign-in' ? (
              // The icon a session already shows on a server awaiting sign-in
              // (`MCPServerPill`), so the card and the thing it installs are
              // recognisably about the same step.
              <LoginOutlined style={{ color: token.colorTextTertiary }} />
            ) : connect.readiness === 'api-key' ? (
              // A key, not the padlock: the padlock is what `blocked` wears,
              // and this entry is connectable — it just wants something from
              // the user first.
              <KeyOutlined style={{ color: token.colorTextTertiary }} />
            ) : connect.readiness === 'unchecked' ? (
              <QuestionCircleOutlined style={{ color: token.colorTextTertiary }} />
            ) : (
              <LockOutlined style={{ color: token.colorTextTertiary }} />
            )}
            <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              {connect.label}
            </Text>
          </Space>
        </Tooltip>
      </Flex>
    </Card>
  );
};

export const CatalogCard = memo(CatalogCardInner);
