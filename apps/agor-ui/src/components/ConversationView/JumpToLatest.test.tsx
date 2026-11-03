import type { Message, StreamingMessageState } from '@agor-live/client';
import { renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useNewMessageCount } from './JumpToLatest';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 14, 12, minute)).toISOString();
const message = (id: string, minute: number, content: Message['content'], role = 'assistant') =>
  ({ message_id: id, role, timestamp: at(minute), content }) as Message;

it('counts text messages newer than the reader left, never older history or tool traffic', () => {
  const byTask = new Map([['t1', [message('a', 1, 'Earlier answer')]]]);
  const streams = new Map<string, StreamingMessageState>();
  const { result, rerender } = renderHook(
    ({ away, messages }) => useNewMessageCount(away, messages, streams),
    { initialProps: { away: true, messages: byTask } }
  );
  expect(result.current).toBe(0);

  const next = new Map([
    ['t0', [message('old', 0, 'Paged-in history')]],
    [
      't1',
      [
        message('a', 1, 'Earlier answer'),
        message('tool', 2, [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
        message('result', 2, [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }], 'user'),
        message('b', 3, [{ type: 'text', text: 'New answer' }]),
      ],
    ],
    ['t2', [message('c', 4, 'Next prompt', 'user')]],
  ]);
  streams.set('d', {
    message_id: 'd',
    content: 'Streaming',
    timestamp: at(5),
  } as StreamingMessageState);
  rerender({ away: true, messages: next });
  expect(result.current).toBe(3);

  rerender({ away: false, messages: next });
  expect(result.current).toBe(0);
});
