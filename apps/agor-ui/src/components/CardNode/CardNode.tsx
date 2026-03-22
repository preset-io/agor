/**
 * CardNode - React Flow node component for rendering cards on the board canvas.
 *
 * Visual hierarchy:
 * - Colored left border from CardType (or override)
 * - CardType emoji + title (with optional URL link)
 * - Description (collapsed after ~100 chars)
 * - Note (always shown in full, distinct background)
 */

import type { CardWithType } from '@agor/core/types';
import { DragOutlined, LinkOutlined } from '@ant-design/icons';
import { Button, Typography, theme } from 'antd';
import React, { useMemo, useState } from 'react';

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
  const { card, onClick } = data;
  const [descExpanded, setDescExpanded] = useState(false);

  const borderColor = card.effective_color || token.colorBorder;
  const emoji = card.effective_emoji;

  const truncatedDesc = useMemo(() => {
    if (!card.description) return '';
    if (card.description.length <= DESCRIPTION_MAX_CHARS || descExpanded) return card.description;
    const truncated = card.description.slice(0, DESCRIPTION_MAX_CHARS);
    const lastSpace = truncated.lastIndexOf(' ');
    return (
      (lastSpace > DESCRIPTION_MAX_CHARS * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '...'
    );
  }, [card.description, descExpanded]);

  const needsTruncation = (card.description?.length ?? 0) > DESCRIPTION_MAX_CHARS;

  return (
    <div
      onClick={() => onClick?.(card.card_id)}
      style={{
        width: CARD_WIDTH,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderLeft: `4px solid ${borderColor}`,
        borderRadius: token.borderRadiusLG,
        cursor: 'pointer',
        overflow: 'hidden',
        boxShadow: token.boxShadowTertiary,
        transition: 'box-shadow 0.2s',
      }}
    >
      {/* Header: emoji + title + link + drag */}
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
        {card.url && (
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
