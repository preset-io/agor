import { type Message, type Task, TaskStatus } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskBlock } from './TaskBlock';

const QUESTION = 'Fix the mobile loading skeletons';
const ANSWER = 'Wrapped each skeleton in the same card chrome.';

const task = {
  task_id: 'task-1',
  session_id: 'session-1',
  created_by: 'user-1',
  full_prompt: QUESTION,
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-20T00:00:00.000Z',
  completed_at: '2026-09-20T00:02:14.000Z',
  duration_ms: 134_000,
  model: 'claude-opus-5',
  tool_use_count: 1,
  git_state: { ref_at_start: 'feature-compact', sha_at_start: 'unknown' },
} as unknown as Task;

/** Question → agent activity → written answer. */
const messages = [
  {
    message_id: 'm1',
    session_id: 'session-1',
    role: 'user',
    index: 0,
    timestamp: '2026-09-20T00:00:00.000Z',
    content: QUESTION,
  },
  {
    message_id: 'm2',
    session_id: 'session-1',
    role: 'assistant',
    index: 1,
    timestamp: '2026-09-20T00:00:10.000Z',
    content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/Card.tsx' } }],
  },
  {
    message_id: 'm3',
    session_id: 'session-1',
    role: 'user',
    index: 2,
    timestamp: '2026-09-20T00:00:20.000Z',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
  },
  {
    message_id: 'm4',
    session_id: 'session-1',
    role: 'assistant',
    index: 3,
    timestamp: '2026-09-20T00:02:14.000Z',
    content: ANSWER,
  },
] as unknown as Message[];

function renderTask(compact: boolean, isExpanded = false) {
  return render(
    <TaskBlock
      task={task}
      compact={compact}
      isExpanded={isExpanded}
      onExpandChange={() => {}}
      taskMessages={messages}
      taskMessagesLoaded
      onLoadTaskMessages={() => {}}
      onUnloadTaskMessages={() => {}}
    />
  );
}

describe('TaskBlock compact view', () => {
  it('renders a flat transcript with no task accordion', () => {
    const { container } = renderTask(true);

    expect(container.querySelector('.ant-collapse')).toBeNull();
    // Question and written answer are visible without any expanding.
    expect(screen.getByText(QUESTION)).toBeVisible();
    expect(screen.getByText(ANSWER)).toBeVisible();
  });

  it('makes additional task metadata available through a semantic disclosure', () => {
    const { container } = renderTask(true);

    const separator = container.querySelector('.ant-divider');
    expect(separator).not.toBeNull();
    const toggle = screen.getByRole('button', { name: /opus-5.*2m 14s/ });
    expect(toggle.closest('[role="separator"], [aria-hidden="true"]')).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Duration 2m 14s · Git feature-compact')).toBeVisible();
  });

  it('collapses only the in-between agent activity', () => {
    renderTask(true);

    // The chain is one quiet row until clicked; the tool call is inside it.
    const chainSummary = screen.getByText(/^Worked/);
    expect(screen.queryByText('Read')).not.toBeInTheDocument();

    fireEvent.click(chainSummary);

    expect(screen.getByText('Read')).toBeVisible();
    // Opening activity never hid the conversation itself.
    expect(screen.getByText(QUESTION)).toBeVisible();
    expect(screen.getByText(ANSWER)).toBeVisible();
  });
});

describe('TaskBlock detailed view', () => {
  it('keeps the collapsible task section', () => {
    const { container } = renderTask(false);

    expect(container.querySelector('.ant-collapse')).not.toBeNull();
    expect(container.querySelector('.ant-divider')).toBeNull();
    // Collapsed: the header pills stand in for the content.
    expect(screen.getByText('opus-5')).toBeVisible();
    expect(screen.queryByText(ANSWER)).not.toBeInTheDocument();
  });

  it('reveals the task content when expanded', () => {
    renderTask(false, true);

    expect(screen.getByText(ANSWER)).toBeVisible();
  });
});
