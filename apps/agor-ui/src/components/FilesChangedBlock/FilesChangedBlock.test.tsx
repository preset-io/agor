import type { Message, Task } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskBlock } from '../TaskBlock/TaskBlock';

const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }];

const call = (
  index: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
  diff?: unknown
): Message[] =>
  [
    {
      message_id: `${id}-call`,
      session_id: 'session-1',
      type: 'message',
      role: 'assistant',
      index,
      timestamp: '2026-09-21T00:00:00.000Z',
      content: [{ type: 'tool_use', id, name, input }],
    },
    {
      message_id: `${id}-result`,
      session_id: 'session-1',
      type: 'message',
      role: 'user',
      index: index + 1,
      timestamp: '2026-09-21T00:00:01.000Z',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(diff ? { diff } : {}) }],
    },
  ] as unknown as Message[];

const messages = [
  ...call(0, 'r1', 'Read', { file_path: '/repo/Catalog.tsx' }),
  ...call(
    2,
    'e1',
    'Edit',
    { file_path: '/repo/CatalogTab.tsx' },
    {
      structuredPatch: patch(['-was', '+is', '+also']),
    }
  ),
];

const task = {
  task_id: 'task-1',
  session_id: 'session-1',
  created_by: 'user-1',
  full_prompt: 'Fix the catalog',
  status: 'completed',
  created_at: '2026-09-21T00:00:00.000Z',
  tool_use_count: 2,
  git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
} as unknown as Task;

const renderTask = (compact: boolean, taskMessages = messages) =>
  render(
    <TaskBlock
      task={task}
      compact={compact}
      isExpanded
      onExpandChange={() => {}}
      taskMessages={taskMessages}
      taskMessagesLoaded
      onLoadTaskMessages={() => {}}
      onUnloadTaskMessages={() => {}}
    />
  );

/** Transcript rows are real buttons; the task header is a role-only div. */
const rowNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-conversation-block] button')).map(
    (button) => button.textContent
  );

describe('Files changed inside a transcript', () => {
  it('retains chain elapsed time when its last edit moves into the file disclosure', () => {
    const timed = messages.map((message, index) => ({
      ...message,
      timestamp: `2026-09-21T00:00:${['00', '01', '10', '20'][index]}.000Z`,
    }));
    const { container } = renderTask(true, timed);
    expect(rowNames(container)).toEqual([
      'Worked for 20s · 2 steps · 1 file',
      'CatalogTab.tsx+2-1',
    ]);
  });

  it('aggregates a loose call and its separately arriving result exactly once', () => {
    const [callMessage, resultMessage] = call(
      0,
      'loose-edit',
      'Edit',
      { file_path: '/repo/Example.tsx' },
      { structuredPatch: patch(['-old', '+new']) }
    );
    const promptAndCall = {
      ...callMessage,
      content: [
        { type: 'text', text: 'Updating the example' },
        ...(Array.isArray(callMessage.content) ? callMessage.content : []),
      ],
    } as Message;
    const view = (taskMessages: Message[], compact = true) => (
      <TaskBlock
        task={task}
        compact={compact}
        isExpanded
        onExpandChange={() => {}}
        taskMessages={taskMessages}
        taskMessagesLoaded
        onLoadTaskMessages={() => {}}
        onUnloadTaskMessages={() => {}}
      />
    );
    const { container, rerender } = render(view([promptAndCall]));
    expect(rowNames(container).some((name) => name?.startsWith('Edit'))).toBe(true);

    rerender(view([promptAndCall, resultMessage]));
    expect(screen.getByText('Updating the example')).toBeVisible();
    expect(rowNames(container)).toEqual(['Example.tsx+1-1']);

    rerender(view([promptAndCall, resultMessage], false));
    expect(rowNames(container).some((name) => name?.startsWith('Edit'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Example.tsx+1-1' })).not.toBeInTheDocument();
  });

  it('shows an edit once, in the grouped line rather than the activity rows', () => {
    const { container } = renderTask(true);

    // The edit and the thought reporting its result both leave the chain; the
    // read and its result stay behind in the summary.
    expect(rowNames(container)).toEqual(['Worked for 1s · 2 steps · 1 file', 'CatalogTab.tsx+2-1']);
  });

  it('leaves detailed rendering every tool call in the flow', () => {
    const { container } = renderTask(false);

    expect(rowNames(container)).toEqual([
      'Read/repo/Catalog.tsx',
      'Thinkingok',
      'Edit/repo/CatalogTab.tsx',
      'Thinkingok',
    ]);
  });
});
