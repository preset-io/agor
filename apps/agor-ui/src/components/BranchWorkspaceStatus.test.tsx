import type { BranchWorkspaceOperation } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { makeBranch } from './BranchModal/testUtils';
import { BranchWorkspaceStatus } from './BranchWorkspaceStatus';

it('shows durable uncertainty and preserves a previous failure during a retry', () => {
  const branch = makeBranch();
  const operation = {
    operation_id: '01900000-0000-7000-8000-000000000001',
    action: 'clean',
    filesystem_action: 'cleaned',
    status: 'running',
    requested_by: branch.created_by,
    requested_at: '2026-01-01T00:00:00Z',
    deadline_at: '2026-01-01T00:06:00Z',
  } as BranchWorkspaceOperation;
  const view = render(
    <BranchWorkspaceStatus
      branch={{
        ...branch,
        workspace_operation: operation,
        cleanup_last_error: {
          operation_id:
            '01900000-0000-7000-8000-000000000002' as BranchWorkspaceOperation['operation_id'],
          at: '2025-12-31',
          message: 'Earlier failure',
        },
      }}
    />
  );
  expect(screen.getByText(/Branch cleanup: unknown/)).toBeInTheDocument();
  expect(screen.getByText(/Earlier failure/)).toBeInTheDocument();
  view.rerender(
    <BranchWorkspaceStatus
      branch={{ ...branch, workspace_operation: { ...operation, status: 'succeeded' } }}
    />
  );
  expect(screen.getByText(/Branch cleanup: succeeded/)).toBeInTheDocument();
  expect(screen.queryByText(/Earlier failure/)).not.toBeInTheDocument();
});

it('dismisses the current notification without hiding a later status or cleanup operation', () => {
  const branch = makeBranch();
  const operation = {
    operation_id: '01900000-0000-7000-8000-000000000001',
    action: 'clean',
    filesystem_action: 'cleaned',
    status: 'running',
    requested_by: branch.created_by,
    requested_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  } as BranchWorkspaceOperation;
  const show = (value: BranchWorkspaceOperation) => (
    <BranchWorkspaceStatus branch={{ ...branch, workspace_operation: value }} />
  );
  const view = render(show(operation));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss workspace notification' }));
  expect(screen.queryByText(/Branch cleanup:/)).not.toBeInTheDocument();
  view.rerender(show({ ...operation }));
  expect(screen.queryByText(/Branch cleanup:/)).not.toBeInTheDocument();
  expect(operation.status).toBe('running');
  const succeeded = { ...operation, status: 'succeeded' as const };
  view.rerender(show(succeeded));
  expect(screen.getByText(/Branch cleanup: succeeded/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss workspace notification' }));
  expect(screen.queryByText(/Branch cleanup:/)).not.toBeInTheDocument();
  view.rerender(
    show({
      ...succeeded,
      operation_id:
        '01900000-0000-7000-8000-000000000002' as BranchWorkspaceOperation['operation_id'],
    })
  );
  expect(screen.getByText(/Branch cleanup: succeeded/)).toBeInTheDocument();
});

it('keeps the timestamp in hover details rather than a second alert line', async () => {
  const branch = makeBranch();
  const finished = '2026-01-01T00:01:00Z';
  render(
    <BranchWorkspaceStatus
      branch={{
        ...branch,
        workspace_operation: {
          operation_id: '01900000-0000-7000-8000-000000000001',
          action: 'clean',
          filesystem_action: 'cleaned',
          status: 'succeeded',
          requested_by: branch.created_by,
          requested_at: '2026-01-01T00:00:00Z',
          deadline_at: '2026-01-01T00:06:00Z',
          finished_at: finished,
        } as BranchWorkspaceOperation,
      }}
    />
  );
  expect(screen.queryByText(new RegExp(finished))).not.toBeInTheDocument();
  fireEvent.mouseEnter(screen.getByText(/Branch cleanup: succeeded/));
  expect(await screen.findByRole('tooltip')).toHaveTextContent(finished);
});
