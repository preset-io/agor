/**
 * CardNode - React Flow node component for rendering cards on the board canvas.
 *
 * Visual hierarchy:
 * - Colored left border from CardType (or override)
 * - Zone border color when pinned to a zone (matching BranchCard pattern)
 * - CardType emoji + title (with optional URL link)
 * - Pin icon when in a zone (click to unpin)
 * - Description (markdown, collapsed after ~3 lines)
 * - Note (complete inside the bounded keyboard-scrollable body)
 */

// biome-ignore-all lint/a11y/noNoninteractiveTabindex: the bounded overflow section must be keyboard-focusable so arrow/Page keys can scroll its complete content

import { GENERIC_BOARD_CARD_LAYOUT, hasCardDensityBody } from '@agor/core/layout/zone-layout';
import type { CardWithType } from '@agor-live/client';
import {
  DragOutlined,
  LinkOutlined,
  MinusSquareOutlined,
  PlusSquareOutlined,
  PushpinFilled,
} from '@ant-design/icons';
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
import {
  REACT_FLOW_DRAG_HANDLE_CLASS,
  REACT_FLOW_NO_DRAG_CLASS,
} from '../../utils/reactFlowDragClasses';
import { ensureColorVisible, isDarkTheme } from '../../utils/theme';
import { MarkdownPreview } from '../MarkdownRenderer';

export interface CardNodeData {
  card: CardWithType;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  onClick?: (cardId: string) => void;
  onUnpin?: (cardId: string) => void;
  /** Shared board presentation state, controlled by board layout/MCP tools. */
  compact?: boolean;
  /** Omitted when the viewer cannot mutate the board. */
  onToggleCompact?: (cardId: string, compact: boolean) => void;
  /** Keep a called-out card's rolling Auto Zone deferral alive. */
  onAutoZoneInteraction?: (cardId: string) => void;
}

const CardNodeComponent = ({ data }: { data: CardNodeData }) => {
  const { token } = theme.useToken();
  const {
    card,
    isPinned,
    zoneName,
    zoneColor,
    onClick,
    onUnpin,
    compact = false,
    onToggleCompact,
    onAutoZoneInteraction,
  } = data;
  const [bodyFocused, setBodyFocused] = useState(false);
  const hasCollapsibleBody = hasCardDensityBody(card);
  // Old payloads may carry compact for a card whose body was later removed.
  // Keep that header-only surface expanded and control-free rather than
  // manufacturing an inert density state.
  const isCompact = hasCollapsibleBody && compact;

  const borderColor = card.effective_color || token.colorBorder;
  const emoji = card.effective_emoji;

  // Match BranchCard pattern: ensure pin icon color is visible
  const isDarkMode = isDarkTheme(token);
  const visiblePinColor = useMemo(() => {
    if (!zoneColor) return undefined;
    return ensureColorVisible(zoneColor, isDarkMode, 50, 50);
  }, [zoneColor, isDarkMode]);

  return (
    <div
      onClick={() => onClick?.(card.card_id)}
      onClickCapture={() => onAutoZoneInteraction?.(card.card_id)}
      onPointerDownCapture={() => onAutoZoneInteraction?.(card.card_id)}
      onFocusCapture={() => onAutoZoneInteraction?.(card.card_id)}
      style={{
        width: GENERIC_BOARD_CARD_LAYOUT.width,
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
      {/* Header: emoji + title + link + density + pin + drag */}
      <div
        data-zone-stack-header
        className={REACT_FLOW_DRAG_HANDLE_CLASS}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          cursor: 'grab',
          borderBottom:
            hasCollapsibleBody && !isCompact ? `1px solid ${token.colorBorderSecondary}` : 'none',
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
            className={REACT_FLOW_NO_DRAG_CLASS}
            style={{ color: token.colorTextSecondary, flexShrink: 0 }}
          >
            <LinkOutlined style={{ fontSize: 12 }} />
          </a>
        )}
        {hasCollapsibleBody && onToggleCompact && (
          <Button
            type="text"
            size="small"
            icon={isCompact ? <PlusSquareOutlined /> : <MinusSquareOutlined />}
            aria-label={isCompact ? 'Expand card' : 'Collapse card'}
            title={isCompact ? 'Expand card' : 'Collapse card'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCompact(card.card_id, !isCompact);
            }}
            className={REACT_FLOW_NO_DRAG_CLASS}
            style={{ flexShrink: 0, width: 24, height: 24, padding: 0 }}
          />
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
              className={REACT_FLOW_NO_DRAG_CLASS}
              style={{ flexShrink: 0, width: 24, height: 24, padding: 0 }}
            />
          </Tooltip>
        )}
        <Button
          type="text"
          size="small"
          icon={<DragOutlined />}
          className={REACT_FLOW_DRAG_HANDLE_CLASS}
          style={{ cursor: 'grab', flexShrink: 0, width: 24, height: 24, padding: 0 }}
        />
      </div>

      {!isCompact && hasCollapsibleBody && (
        <section
          data-card-density-body
          className={`${REACT_FLOW_NO_DRAG_CLASS} nopan nowheel`}
          aria-label={`${card.title} details`}
          tabIndex={0}
          onFocus={() => setBodyFocused(true)}
          onBlur={() => setBodyFocused(false)}
          style={{
            maxHeight: GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            scrollbarGutter: 'stable',
            boxShadow: bodyFocused ? `inset 0 0 0 2px ${token.colorPrimary}` : 'none',
          }}
        >
          {/* Markdown preview/expansion stays inside the bounded body. */}
          {card.description && (
            <div
              style={{
                padding: '8px 12px',
                borderBottom: card.note ? `1px solid ${token.colorBorderSecondary}` : 'none',
              }}
            >
              <MarkdownPreview
                key={card.card_id}
                content={card.description}
                // When a note follows, the density body remains the only
                // bounded scroll container. Description-only cards retain the
                // shared preview's bounded expanded viewport from main.
                boundExpandedHeight={!card.note}
              />
            </div>
          )}

          {/* Notes remain complete and keyboard-scrollable inside the same body. */}
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
        </section>
      )}
    </div>
  );
};

const CardNode = React.memo(CardNodeComponent);

export default CardNode;
