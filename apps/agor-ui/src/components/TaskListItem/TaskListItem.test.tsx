import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TaskListItem from './TaskListItem';

// Inline test data (no separate mocks file needed)
const createMockTask = (overrides = {}) => ({
  task_id: 'task-123',
  session_id: 'session-123',
  created_by: 'user-123',
  full_prompt: 'Test task',
  status: 'COMPLETED',
  message_range: {
    start_index: 0,
    end_index: 10,
    start_timestamp: new Date().toISOString(),
  },
  recorded_tool_count: 5,
  git_state: {
    ref_at_start: 'main',
    sha_at_start: 'abc123',
    sha_at_end: 'def456',
  },
  created_at: new Date().toISOString(),
  ...overrides,
});

describe('TaskListItem', () => {
  it('renders completed task', () => {
    const task = createMockTask({
      full_prompt: 'Design JWT authentication flow',
      status: 'COMPLETED',
    });
    render(<TaskListItem task={task} />);
    expect(screen.getByText('Design JWT authentication flow')).toBeInTheDocument();
  });

  it('renders running task', () => {
    const task = createMockTask({
      full_prompt: 'Implement JWT auth endpoints',
      status: 'RUNNING',
    });
    render(<TaskListItem task={task} />);
    expect(screen.getByText('Implement JWT auth endpoints')).toBeInTheDocument();
  });

  it('shows message count', () => {
    const task = createMockTask({
      full_prompt: 'Design JWT authentication flow',
      message_range: {
        start_index: 0,
        end_index: 12, // 12 - 0 + 1 = 13 messages
        start_timestamp: new Date().toISOString(),
      },
    });
    render(<TaskListItem task={task} />);
    expect(screen.getByText(/13/)).toBeInTheDocument();
  });

  it('shows report indicator when report exists', () => {
    const task = createMockTask({
      full_prompt: 'Design JWT authentication flow',
      report: {
        path: 'session-123/task-123.md',
        template: 'default',
        generated_at: new Date().toISOString(),
      },
    });
    render(<TaskListItem task={task} />);
    expect(screen.getByText('report')).toBeInTheDocument();
  });
});

it('omits unknown tool counts but preserves a verified zero', () => {
  const { rerender } = render(<TaskListItem task={createMockTask()} />);
  expect(screen.getByText('5')).toBeInTheDocument();
  rerender(<TaskListItem task={createMockTask({ recorded_tool_count: null })} />);
  expect(screen.queryByText('5')).toBeNull();
  expect(screen.queryByText('0')).toBeNull();
  rerender(<TaskListItem task={createMockTask({ recorded_tool_count: 0 })} />);
  expect(screen.getByText('0')).toBeInTheDocument();
});
