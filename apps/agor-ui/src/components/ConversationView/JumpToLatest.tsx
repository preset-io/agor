import type {
  Message,
  ReactiveMessagesByTask,
  ReactiveStreamingMessagesById,
} from '@agor-live/client';
import { ArrowDownOutlined } from '@ant-design/icons';
import { Button, Flex, Typography, theme } from 'antd';
import { useRef } from 'react';
import { useIsTouchInput } from '../../hooks/useCanHover';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
} as const;

const hasText = (content: Message['content'] | string) =>
  typeof content === 'string'
    ? content.trim() !== ''
    : Array.isArray(content) &&
      content.some(
        (block) => block.type === 'text' && typeof block.text === 'string' && !!block.text.trim()
      );

/**
 * Text messages that arrived while the reader was away from the bottom.
 * Only messages newer than the newest one present on leaving count, so paging
 * in older history or loading an old turn's details never does.
 */
export function useNewMessageCount(
  away: boolean,
  messagesByTask: ReactiveMessagesByTask | undefined,
  streamingMessages: ReactiveStreamingMessagesById
): number {
  const baseline = useRef<number | null>(null);
  if (!away) {
    baseline.current = null;
    return 0;
  }
  const times = new Map<string, number>();
  for (const messages of messagesByTask?.values() ?? []) {
    for (const message of messages) {
      if (message.role !== 'system' && hasText(message.content)) {
        times.set(message.message_id, Date.parse(message.timestamp));
      }
    }
  }
  for (const stream of streamingMessages.values()) {
    if (hasText(stream.content)) times.set(stream.message_id, Date.parse(stream.timestamp));
  }
  if (baseline.current === null) {
    baseline.current = Number.NEGATIVE_INFINITY;
    for (const time of times.values()) baseline.current = Math.max(baseline.current, time);
  }
  let count = 0;
  for (const time of times.values()) if (time > baseline.current) count++;
  return count;
}

/** Floats over the bottom of the transcript, just above the composer. */
export function JumpToLatest({ count, onJump }: { count: number; onJump: () => void }) {
  const { token } = theme.useToken();
  const touch = useIsTouchInput();
  return (
    <Flex
      justify="center"
      style={{
        position: 'absolute',
        insetInline: 0,
        bottom: token.marginSM,
        pointerEvents: 'none',
      }}
    >
      <Button
        className="agor-jump-pill-enter"
        shape="round"
        icon={<ArrowDownOutlined />}
        onClick={onJump}
        style={{
          pointerEvents: 'auto',
          boxShadow: token.boxShadowSecondary,
          minHeight: touch ? MOBILE_TOUCH_TARGET : undefined,
        }}
      >
        Jump to latest
        {count > 0 && (
          <Typography.Text type="secondary" aria-hidden="true">
            {count} new
          </Typography.Text>
        )}
      </Button>
      <span role="status" style={SR_ONLY}>
        {count > 0 ? `${count} new ${count === 1 ? 'message' : 'messages'}` : ''}
      </span>
    </Flex>
  );
}
