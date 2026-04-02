/**
 * CardNode - React Flow node component for rendering cards on the board canvas.
 *
 * Visual hierarchy:
 * - Colored left border from CardType (or override)
 * - Zone border color when pinned to a zone (matching WorktreeCard pattern)
 * - CardType emoji + title (with optional URL link)
 * - Pin icon when in a zone (click to unpin)
 * - Description (collapsed after ~100 chars)
 * - Note (always shown in full, distinct background)
 */

import type { CardWithType } from '@agor/core/types';
import { DragOutlined, LinkOutlined, PushpinFilled } from '@ant-design/icons';
import { Button, Tooltip, Typography, theme } from 'antd';

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

import React, { useMemo, useState } from 'react';
import { ensureColorVisible } from '../../utils/theme';

const DESCRIPTION_MAX_CHARS = 100;
const CARD_WIDTH = 380;

export interface CardNodeData {
  card: CardWithType;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  onClick?: (cardId: string) => void;
  onUnpin?: (cardId: string) => void;
}

const CardNodeComponent = ({ data }: { data: CardNodeData }) => {
  const { token } = theme.useToken();
  const { card, isPinned, zoneName, zoneColor, onClick, onUnpin } = data;
  const [descExpanded, setDescExpanded] = useState(false);

  const borderColor = card.effective_color || token.colorBorder;
  const emoji = card.effective_emoji;

  // Match WorktreeCard pattern: ensure pin icon color is visible
  const isDarkMode = token.colorBgContainer !== '#ffffff';
  const visiblePinColor = useMemo(() => {
    if (!zoneColor) return undefined;
    return ensureColorVisible(zoneColor, isDarkMode, 50, 50);
  }, [zoneColor, isDarkMode]);

  const truncatedDesc = useMemo(() => {
    if (!card.description) return '';
    if (card.description.length <= DESCRIPTION_MAX_CHARS || descExpanded) return card.description;
    const truncated = card.description.slice(0, DESCRIPTION_MAX_CHARS);
    const lastSpace = truncated.lastIndexOf(' ');
    return `${lastSpace > DESCRIPTION_MAX_CHARS * 0.7 ? truncated.slice(0, lastSpace) : truncated}...`;
  }, [card.description, descExpanded]);

  const needsTruncation = (card.description?.length ?? 0) > DESCRIPTION_MAX_CHARS;

  return (
    <div
      onClick={() => onClick?.(card.card_id)}
      style={{
        width: CARD_WIDTH,
        background: token.colorBgContainer,
        border:
          isPinned && zoneColor
            ? `1px solid ${zoneColor}`
            : `1px solid ${token.colorBorderSecondary}`,
        borderLeft: `4px solid ${isPinned && zoneColor ? zoneColor : borderColor}`,
        borderRadius: token.borderRadiusLG,
        cursor: 'pointer',
        overflow: 'hidden',
        boxShadow: token.boxShadowTertiary,
        transition: 'box-shadow 0.2s, border-color 0.3s',
      }}
    >
      {/* Header: emoji + title + link + pin + drag */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderBottom:
            card.description || card.note ? `1px solid ${token.colorBorderSecondary}` : 'none',
        }}
      >
        {emoji && <span style={{ fontSize: 16, flexShrink: 0 }}>{emoji}</span>}
        <Typography.Text
          strong
          style={{
            flex: 1,
            fontSize: 13,
            lineHeight: '1.3',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {card.title}
        </Typography.Text>
        {card.url && isSafeUrl(card.url) && (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="nodrag"
            style={{ color: token.colorTextSecondary, flexShrink: 0 }}
          >
            <LinkOutlined style={{ fontSize: 12 }} />
          </a>
        )}
        {isPinned && (
          <Tooltip
            title={
              zoneName ? `Pinned to [${zoneName}] zone (click to unpin)` : 'Pinned (click to unpin)'
            }
          >
            <Button
              type="text"
              size="small"
              icon={<PushpinFilled style={{ color: visiblePinColor }} />}
              onClick={(e) => {
                e.stopPropagation();
                onUnpin?.(card.card_id);
              }}
              className="nodrag"
              style={{ flexShrink: 0, width: 24, height: 24, padding: 0 }}
            />
          </Tooltip>
        )}
        <Button
          type="text"
          size="small"
          icon={<DragOutlined />}
          className="drag-handle"
          style={{ cursor: 'grab', flexShrink: 0, width: 24, height: 24, padding: 0 }}
        />
      </div>

      {/* Description (collapsed) */}
      {card.description && (
        <div
          className="nodrag"
          style={{
            padding: '8px 12px',
            borderBottom: card.note ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}
        >
          <Typography.Text
            style={{
              fontSize: 12,
              color: token.colorTextSecondary,
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {truncatedDesc}
          </Typography.Text>
          {needsTruncation && (
            <Button
              type="link"
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setDescExpanded(!descExpanded);
              }}
              style={{
                padding: 0,
                height: 'auto',
                fontSize: 11,
                color: token.colorLink,
                marginLeft: 4,
              }}
            >
              {descExpanded ? 'less' : 'more'}
            </Button>
          )}
        </div>
      )}

      {/* Note (always shown in full, distinct background) */}
      {card.note && (
        <div
          style={{
            padding: '8px 12px',
            background: token.colorFillQuaternary,
            borderTop: !card.description ? `1px solid ${token.colorBorderSecondary}` : 'none',
          }}
        >
          <Typography.Text
            style={{
              fontSize: 12,
              color: token.colorText,
              lineHeight: '1.5',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {card.note}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

const CardNode = React.memo(CardNodeComponent);

export default CardNode;
