import type { Message, Task } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { MessageBlock } from '../MessageBlock/MessageBlock';
import { TaskBlock } from '../TaskBlock/TaskBlock';
import { FilesChangedBlock } from './FilesChangedBlock';
import { collectFileChanges } from './taskFileChanges';

afterEach(cleanup);

const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }];

/** An assistant tool call and its result, as the transcript stores them. */
const call = (
  index: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
  diff?: unknown,
  parentToolUseId?: string
): Message[] =>
  [
    {
      message_id: `${id}-call`,
      session_id: 'session-1',
      role: 'assistant',
      index,
      timestamp: '2026-09-21T00:00:00.000Z',
      parent_tool_use_id: parentToolUseId,
      content: [{ type: 'tool_use', id, name, input }],
    },
    {
      message_id: `${id}-result`,
      session_id: 'session-1',
      role: 'user',
      index: index + 1,
      timestamp: '2026-09-21T00:00:01.000Z',
      parent_tool_use_id: parentToolUseId,
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(diff ? { diff } : {}) }],
    },
  ] as unknown as Message[];

const readCall = call(0, 'r1', 'Read', { file_path: '/repo/Catalog.tsx' });
const editCall = call(
  2,
  'e1',
  'Edit',
  { file_path: '/repo/CatalogTab.tsx' },
  {
    structuredPatch: patch(['-was', '+is', '+also']),
  }
);
/** An edit performed inside the turn's subagent chain. */
const subagentEdit = call(
  4,
  'e2',
  'Write',
  { file_path: '/repo/CatalogCard.tsx' },
  { structuredPatch: patch(['+fresh']) },
  'task-1'
);

const taskView = (messages: Message[]) => (
  <TaskBlock
    task={
      {
        task_id: 'task-1',
        session_id: 'session-1',
        created_by: 'user-1',
        full_prompt: 'Edit both files',
        status: 'completed',
        created_at: '2026-09-21T00:00:00.000Z',
        git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
      } as unknown as Task
    }
    compact
    isExpanded
    onExpandChange={() => {}}
    taskMessages={messages}
    taskMessagesLoaded
    onLoadTaskMessages={() => {}}
    onUnloadTaskMessages={() => {}}
  />
);

const metadataTask = {
  task_id: 'task-1',
  session_id: 'session-1',
  created_by: 'user-1',
  full_prompt: 'Edit both files',
  status: 'completed',
  created_at: '2026-09-21T00:00:00.000Z',
  tool_use_count: 0,
  duration_ms: 6500,
  model: 'claude-sonnet-4-5',
  git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
} as unknown as Task;

describe('Files changed disclosure', () => {
  it('reveals compact task metadata with keyboard and pointer controls', async () => {
    render(
      <TaskBlock
        task={metadataTask}
        compact
        isExpanded
        onExpandChange={() => {}}
        taskMessages={[]}
        taskMessagesLoaded
        onLoadTaskMessages={() => {}}
        onUnloadTaskMessages={() => {}}
      />
    );

    const toggle = screen.getByRole('button', { name: /sonnet-4\.5.*7s/i });
    expect(screen.getAllByRole('button')).toHaveLength(1);
    // A focusable disclosure must not live under presentational separator descendants.
    expect(toggle.closest('[role="separator"], [aria-hidden="true"]')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Git main/)).not.toBeInTheDocument();

    await act(async () => userEvent.tab());
    expect(toggle).toHaveFocus();

    await act(async () => userEvent.click(toggle));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: /details/i })).toHaveTextContent(
      'Duration 7s · Git main'
    );

    await act(async () => {
      toggle.focus();
      await userEvent.keyboard('{Enter}');
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Git main/)).not.toBeInTheDocument();

    await act(async () => userEvent.keyboard(' '));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Git main/)).toBeVisible();
  });

  it('moves a loose edit into one keyboard-accessible disclosure when its result arrives', async () => {
    const [request, result] = call(
      0,
      'streamed',
      'Edit',
      { file_path: '/repo/Streamed.tsx' },
      { structuredPatch: patch(['-before', '+after']) }
    );
    const message = {
      ...request,
      content: [
        { type: 'text', text: 'Updating the example' },
        ...(Array.isArray(request.content) ? request.content : []),
      ],
    } as Message;
    const { rerender } = render(taskView([message]));
    expect(screen.getByRole('button', { name: /Edit/ })).toBeVisible();

    rerender(taskView([message, result]));
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Worked for/ })).not.toBeInTheDocument();
    expect(screen.getByText('Updating the example')).toBeVisible();
    const disclosure = screen.getByRole('button', { name: /Streamed\.tsx/ });
    await act(async () => {
      disclosure.focus();
      await userEvent.keyboard('{Enter}');
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('after')).toBeVisible();
  });

  it.each(['chain', 'loose'] as const)(
    'keeps every partially enriched file reachable in a %s',
    async (surface) => {
      const messages = call(
        0,
        'mixed',
        'edit_files',
        {
          changes: [
            { path: 'small.ts', kind: 'update' },
            { path: 'large.txt', kind: 'update' },
          ],
        },
        {
          files: [
            { path: 'small.ts', kind: 'update', structuredPatch: patch(['-before', '+after']) },
          ],
        }
      );
      if (surface === 'chain') {
        render(taskView(messages));
        const chain = screen.getByRole('button', { name: /Worked for/ });
        await act(async () => {
          chain.focus();
          await userEvent.keyboard('{Enter}');
        });
      } else {
        render(
          <>
            <MessageBlock
              message={{
                ...messages[0],
                content: messages.flatMap((message) =>
                  Array.isArray(message.content) ? message.content : []
                ),
              }}
              compact
            />
            <FilesChangedBlock summary={collectFileChanges(messages)} />
          </>
        );
      }

      // No partial grouped disclosure duplicates the original call.
      expect(screen.queryByRole('button', { name: /^small\.ts/ })).not.toBeInTheDocument();
      const edit = screen.getByRole('button', { name: /edit_files/ });
      await act(async () => {
        edit.focus();
        await userEvent.keyboard('{Enter}');
      });
      expect(edit).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('small.ts')).toBeVisible();
      expect(screen.getByText('large.txt')).toBeVisible();
      expect(screen.getByText('after')).toBeVisible();
    }
  );

  it('groups a turn into one line and expands to the diffs', async () => {
    render(<FilesChangedBlock summary={collectFileChanges([...readCall, ...editCall])} />);

    const toggle = screen.getByRole('button', { name: /CatalogTab\.tsx/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText('-1')).toBeVisible();
    expect(screen.queryByText('is')).not.toBeInTheDocument();

    await act(async () => userEvent.tab());
    expect(toggle).toHaveFocus();
    await act(async () => userEvent.keyboard('{Enter}'));

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    expect(screen.getByText('is')).toBeVisible();
  });

  it('aggregates edits made inside the turn subagent chain', () => {
    render(<FilesChangedBlock summary={collectFileChanges([...editCall, ...subagentEdit])} />);

    expect(screen.getByRole('button', { name: /2 files changed/ })).toBeVisible();
    expect(screen.getByText('+3')).toBeVisible();
    expect(screen.getByText('-1')).toBeVisible();
  });

  it('renders nothing when the turn changed no files', () => {
    const { container } = render(<FilesChangedBlock summary={collectFileChanges(readCall)} />);

    expect(container).toBeEmptyDOMElement();
  });
});
