import type { Message, Task } from '@agor-live/client';
import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const renders = vi.hoisted(() => ({
  message: vi.fn((_props: { message: Message }) => null),
  chain: vi.fn((_props: { messages: Message[] }) => null),
}));
vi.mock('../MessageBlock', async () => ({
  MessageBlock: (await import('react')).memo(renders.message),
}));
vi.mock('../AgentChain', async () => ({ AgentChain: (await import('react')).memo(renders.chain) }));

import { TaskBlock } from './TaskBlock';

const task = {
  task_id: 't1',
  session_id: 's1',
  status: 'completed',
  created_at: '2026-09-21T00:00:00Z',
  git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
} as unknown as Task;
const message = (id: string, index: number, role: string, content: unknown) =>
  ({
    message_id: id,
    session_id: 's1',
    type: 'message',
    index,
    role,
    content,
    content_preview: '',
    timestamp: '2026-09-21T00:00:00Z',
  }) as unknown as Message;
const edit = (id: string, index: number) => [
  message(`${id}-call`, index, 'assistant', [
    { type: 'tool_use', id, name: 'Edit', input: { file_path: `/repo/${id}.ts` } },
  ]),
  message(`${id}-result`, index + 1, 'user', [
    {
      type: 'tool_result',
      tool_use_id: id,
      content: 'ok',
      diff: {
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
        ],
      },
    },
  ]),
];
const noop = () => {};
const base = [message('prompt', 0, 'user', 'Update the file'), ...edit('e1', 1)];
const view = (text: string, messages = base) => (
  <TaskBlock
    task={task}
    taskMessages={messages}
    taskMessagesLoaded
    compact
    isExpanded
    onExpandChange={noop}
    onLoadTaskMessages={noop}
    onUnloadTaskMessages={noop}
    streamingMessages={
      new Map([
        [
          'stream',
          {
            ...message('stream', 10, 'assistant', text),
            role: 'assistant' as const,
            content: text,
            isStreaming: true,
          },
        ],
      ])
    }
  />
);

it('keeps unchanged transcript children memoized until aggregated membership changes', () => {
  const { rerender } = render(view('Answer'));
  const promptRenders = () =>
    renders.message.mock.calls.filter(([props]) => props.message.message_id === 'prompt').length;
  const initialPromptRenders = promptRenders();
  const initialChainRenders = renders.chain.mock.calls.length;

  rerender(view('Answer continues'));
  expect(promptRenders()).toBe(initialPromptRenders);
  expect(renders.chain).toHaveBeenCalledTimes(initialChainRenders);

  rerender(view('Answer continues', [...base, ...edit('e2', 3)]));
  expect(promptRenders()).toBe(initialPromptRenders + 1);
});
