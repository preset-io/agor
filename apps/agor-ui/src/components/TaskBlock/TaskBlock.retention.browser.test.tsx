import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);

const task: Task = {
  task_id: generateId(),
  session_id: generateId(),
  created_by: '',
  full_prompt: 'Prompt',
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-01T00:00:00.000Z',
  git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
};
const message = (index: number, role: MessageRole, content: Message['content']): Message => ({
  message_id: `${task.task_id}-${index}`,
  task_id: task.task_id,
  session_id: task.session_id,
  index,
  role,
  type: role === MessageRole.USER ? 'user' : 'assistant',
  timestamp: task.created_at,
  content_preview: '',
  content,
});
const prompt = message(0, MessageRole.USER, 'Prompt');

// Without an AgentChain, loaded detail renders inside the answer's MessageBlock.
// The disclosure the reader asked for must hold the turn before the load pin
// is released, or the cache's byte budget returns the turn to lean at once.
it.each([
  {
    shape: 'reasoning beside text',
    recorded_tool_count: 0,
    detail: [{ type: 'thinking', text: 'INLINE_DETAIL' }],
  },
  {
    shape: 'a Read result beside text',
    recorded_tool_count: 1,
    detail: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/a.txt' } },
      { type: 'tool_result', tool_use_id: 'read-1', content: 'INLINE_DETAIL' },
    ],
  },
  {
    // SDK-normalized empty thinking renders nothing, so the Read is revealed.
    shape: 'a Read result after empty reasoning, beside text',
    recorded_tool_count: 1,
    detail: [
      { type: 'thinking', text: '' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/a.txt' } },
      { type: 'tool_result', tool_use_id: 'read-1', content: 'INLINE_DETAIL' },
    ],
  },
  {
    // The turn's first answer has only empty reasoning: reveal the later Read.
    shape: 'a Read result in a later answer than empty reasoning',
    recorded_tool_count: 1,
    earlier: [{ type: 'thinking', text: '' }],
    detail: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/a.txt' } },
      { type: 'tool_result', tool_use_id: 'read-1', content: 'INLINE_DETAIL' },
    ],
  },
])(
  'opens and pins loaded $shape before the load pin is released',
  async ({ recorded_tool_count, detail, earlier }) => {
    const events: string[] = [];
    let pins = 0;
    const retain = vi.fn(() => {
      const pin = ++pins;
      events.push(`retain ${pin}`);
      return () => events.push(`release ${pin}`);
    });
    let finishLoad = () => {};
    const load = vi.fn(() => new Promise<void>((resolve) => (finishLoad = resolve)));
    const first = (blocks: unknown[]) =>
      message(1, MessageRole.ASSISTANT, [
        ...blocks,
        { type: 'text', text: 'Earlier answer' },
      ] as Message['content']);
    const view = (answer: Message, loaded: boolean) => (
      <TaskBlock
        task={{ ...task, recorded_tool_count }}
        taskMessages={earlier ? [prompt, first(loaded ? earlier : []), answer] : [prompt, answer]}
        taskMessagesLoaded={loaded}
        onLoadTaskMessages={load}
        onRetainTaskDetails={retain}
      />
    );
    const lean = {
      ...message(2, MessageRole.ASSISTANT, [{ type: 'text', text: 'Visible answer' }]),
      has_deferred_reasoning: recorded_tool_count === 0,
    };
    const { rerender } = render(view(lean, false));
    fireEvent.click(screen.getByRole('button', { name: /^(1 tool call|Reasoning)$/ }));
    expect(events).toEqual(['retain 1']);
    const full = message(2, MessageRole.ASSISTANT, [
      ...detail,
      { type: 'text', text: 'Visible answer' },
    ] as Message['content']);
    rerender(view(full, true));
    await waitFor(() => expect(screen.getByText(/INLINE_DETAIL/)).toBeVisible());
    expect(screen.getByText('Visible answer')).toBeVisible();
    expect(events).toEqual(['retain 1', 'retain 2']);
    finishLoad();
    await waitFor(() => expect(events).toEqual(['retain 1', 'retain 2', 'release 1']));
  }
);
