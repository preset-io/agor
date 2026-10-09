import { type Task, TaskStatus } from '@agor/core/types';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { describeTurnOutcome } from '../TaskBlock/describeTurnOutcome';
import { TurnOutcome } from '../TaskBlock/TurnOutcome';
import { turnOutcomeDetails } from '../TaskBlock/turnOutcomeDetails';
import { RecoveryActions } from './RecoveryActions';

const task = {
  task_id: 'task',
  status: TaskStatus.STOPPING,
  sdk_failure: { termination: 'unverified' },
  error_message: 'Remote executor did not acknowledge quiescence.',
} as Task;
describe('recovery actions', () => {
  it('offers retry separately from the risky reopen action', () => {
    const onRetry = vi.fn(),
      onReopen = vi.fn();
    render(
      <RecoveryActions
        task={task}
        busy={false}
        disconnected={false}
        canReopen
        onRetry={onRetry}
        onReopen={onReopen}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onReopen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen anyway…' }));
    expect(onReopen).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('does not offer the override to an unauthorized viewer', () => {
    render(<RecoveryActions task={task} busy={false} disconnected={false} onReopen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Reopen anyway…' })).toBeNull();
    expect(screen.getByText(/Ask the branch owner/)).toBeVisible();
  });
  it.each([
    { busy: true, disconnected: false },
    { busy: false, disconnected: true },
  ])('disables duplicate/offline actions %o', (props) => {
    render(
      <RecoveryActions task={task} {...props} canReopen onRetry={vi.fn()} onReopen={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: /Retry cleanup/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reopen anyway…' })).toBeDisabled();
  });
  it('removes recovery actions when durable state resolves, including late success', () => {
    const { rerender } = render(
      <RecoveryActions task={task} busy={false} disconnected={false} onReopen={vi.fn()} />
    );
    rerender(
      <RecoveryActions
        task={{ ...task, status: TaskStatus.FAILED, sdk_failure: undefined }}
        busy={false}
        disconnected={false}
        onReopen={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
  });
  it('shows plain language first and hides technical diagnostics in a disclosure', () => {
    render(
      <TurnOutcome
        task={task}
        outcome={describeTurnOutcome(task)}
        details={turnOutcomeDetails(task)}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Cleanup needs attention');
    expect(screen.queryByText(task.error_message!)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('region', { name: 'Technical details' })).toHaveTextContent(
      task.error_message!
    );
  });
});
