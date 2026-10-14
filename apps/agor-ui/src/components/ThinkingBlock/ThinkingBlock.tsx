/**
 * ThinkingBlock - A model's extended thinking, collapsed to one quiet line.
 *
 * Live: a shimmering label that escalates with time, plus a timer.
 * Done: "Thought for 12s". The reasoning itself opens on demand.
 */

import { DownOutlined, RightOutlined } from '@ant-design/icons';
import { Button, theme } from 'antd';
import type React from 'react';
import { useId, useState } from 'react';
import { TEXT_TRUNCATION } from '../../constants/ui';
import { useIsTouchInput } from '../../hooks/useCanHover';
import { useRetainTaskDetailsWhile } from '../../hooks/useTaskDetailRetention';
import { VISUALLY_HIDDEN_STYLE } from '../../utils/accessibility';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { CollapsibleText } from '../CollapsibleText';
import {
  formatElapsed,
  LiveLabel,
  thinkingLabel,
  thoughtForLabel,
  useTickingNow,
} from '../LiveStatus';

interface ThinkingBlockProps {
  /** Thinking content (markdown) */
  content: string;
  /** Whether content is still streaming */
  isStreaming?: boolean;
  /** Client clock (ms) when this tab first saw the thinking. */
  startedAt?: number;
  /** Client clock (ms) when the thinking ended. */
  endedAt?: number;
  /** Whether to default to expanded state */
  defaultExpanded?: boolean;
  /** A reader asked for this turn's detail: open on mount (and keep the turn). */
  revealRequested?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({
  content,
  isStreaming = false,
  startedAt,
  endedAt,
  defaultExpanded = false,
  revealRequested = false,
}) => {
  const { token } = theme.useToken();
  const touch = useIsTouchInput();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded || revealRequested);
  const [mountedAt] = useState(Date.now);
  const now = useTickingNow(isStreaming);
  useRetainTaskDetailsWhile(expanded && (!!content || isStreaming));

  // Don't render if no content
  if (!content && !isStreaming) {
    return null;
  }

  const elapsedSeconds = Math.max(0, now - (startedAt ?? mountedAt)) / 1000;
  const label = isStreaming ? thinkingLabel(elapsedSeconds) : thoughtForLabel(startedAt, endedAt);
  // History has no live region; only thinking this tab watched announces its steps.
  const watchedLive = isStreaming || startedAt !== undefined;
  const Chevron = expanded ? DownOutlined : RightOutlined;

  return (
    <div style={{ marginBottom: token.marginXS }}>
      <Button
        type="text"
        block
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={() => setExpanded(!expanded)}
        style={{
          justifyContent: 'flex-start',
          height: 'auto',
          minHeight: touch ? MOBILE_TOUCH_TARGET : undefined,
          paddingInline: 0,
          gap: token.marginXS,
          fontSize: token.fontSizeSM,
          color: token.colorTextSecondary,
        }}
      >
        <LiveLabel active={isStreaming}>{label}</LiveLabel>
        {isStreaming && (
          <span
            aria-hidden="true"
            style={{ color: token.colorTextTertiary, fontVariantNumeric: 'tabular-nums' }}
          >
            · {formatElapsed(elapsedSeconds)}
          </span>
        )}
        <Chevron aria-hidden="true" style={{ fontSize: '0.75em' }} />
      </Button>
      {/* Announces the copy step, never the per-second timer. */}
      {watchedLive && (
        <span role="status" style={VISUALLY_HIDDEN_STYLE}>
          {label}
        </span>
      )}
      {expanded && (
        <div
          id={bodyId}
          style={{
            marginTop: token.marginXXS,
            paddingInlineStart: token.paddingSM,
            borderInlineStart: `2px solid ${token.colorBorderSecondary}`,
          }}
        >
          <CollapsibleText
            maxLines={TEXT_TRUNCATION.DEFAULT_LINES}
            preserveWhitespace
            style={{ fontSize: token.fontSize, margin: 0, color: token.colorTextSecondary }}
          >
            {content || label}
          </CollapsibleText>
        </div>
      )}
    </div>
  );
};
