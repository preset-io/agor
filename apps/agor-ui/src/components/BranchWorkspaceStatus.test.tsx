import type { BranchWorkspaceOperation } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
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
