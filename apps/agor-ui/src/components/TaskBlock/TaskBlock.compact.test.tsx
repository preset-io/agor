import { type Task, TaskStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskBlock } from './TaskBlock';

const task = {
  task_id: 'task-1',
  session_id: 'session-1',
  created_by: 'user-1',
  full_prompt: 'Fix the mobile loading skeletons',
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-20T00:00:00.000Z',
  completed_at: '2026-09-20T00:02:14.000Z',
  duration_ms: 134_000,
  model: 'claude-opus-5',
  tool_use_count: 0,
  git_state: { ref_at_start: 'feature-compact', sha_at_start: 'unknown' },
} as unknown as Task;

function renderTask(compact: boolean) {
  return render(
    <TaskBlock
      task={task}
      compact={compact}
      isExpanded={false}
      onExpandChange={() => {}}
      taskMessages={[]}
      taskMessagesLoaded
      onLoadTaskMessages={() => {}}
      onUnloadTaskMessages={() => {}}
    />
  );
}

describe('TaskBlock compact view', () => {
  it('reduces the metadata pills to one muted model · duration line', () => {
    renderTask(true);

    expect(screen.getByText('opus-5 · 2m 14s')).toBeVisible();
    // The prompt still identifies a collapsed task.
    expect(screen.getByText('Fix the mobile loading skeletons')).toBeVisible();
    // The model pill is one of the pills the compact line replaces.
    expect(screen.queryByText('opus-5')).not.toBeInTheDocument();
  });

  it('keeps the detailed pill row', () => {
    renderTask(false);

    expect(screen.queryByText('opus-5 · 2m 14s')).not.toBeInTheDocument();
    expect(screen.getByText('opus-5')).toBeVisible();
  });
});
