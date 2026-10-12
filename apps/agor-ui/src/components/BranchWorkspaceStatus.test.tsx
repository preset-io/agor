import { generateId } from '@agor/core/ids/browser';
import type { AgorClient, Branch, BranchWorkspaceOperation } from '@agor-live/client';
import { BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { makeBranch, makeUser } from './BranchModal/testUtils';
import { BranchWorkspaceStatus } from './BranchWorkspaceStatus';

const showError = vi.hoisted(() => vi.fn());
vi.mock('../utils/message', () => ({ useThemedMessage: () => ({ showError }) }));
const user = makeUser();
const operation: BranchWorkspaceOperation = {
  operation_id: generateId(),
  action: 'clean',
  filesystem_action: 'cleaned',
  status: 'failed',
  requested_by: user.user_id,
  requested_at: '2026-10-08T00:00:00Z',
  deadline_at: '2026-10-08T00:06:00Z',
  finished_at: '2026-10-08T00:01:00Z',
  error: 'Workspace operation stopped before filesystem execution.',
};
const branch = makeBranch({ filesystem_status: 'ready', workspace_operation: operation });
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function clientFixture() {
  const request = deferred();
  const find = vi.fn(async () => ({ is_owner: true, can: 'all' }));
  const create = vi.fn(() => request.promise);
  const service = vi.fn((path: string) => {
    if (path === 'branches/:id/effective-access') return { find };
    if (path === BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE) return { create };
    throw new Error(`Unexpected service ${path}`);
  });
  return { client: { service } as unknown as AgorClient, create, find, request };
}
function view(client: AgorClient | null, row = branch, authGeneration = 0) {
  return (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
        authGeneration,
      }}
    >
      <BranchWorkspaceStatus branch={row} client={client} currentUser={user} />
    </ConnectionProvider>
  );
}
const dismissLabel = 'Dismiss notification for everyone';
beforeEach(() => vi.clearAllMocks());

it('uses a short title and readable error instead of combining historical errors into the title', () => {
  render(
    view(null, {
      ...branch,
      cleanup_last_error: {
        operation_id: generateId(),
        at: '2025-12-31',
        message: 'Earlier failure',
      },
    })
  );
  expect(screen.getByText('Branch cleanup failed')).not.toBeNull();
  expect(screen.getByText(operation.error!)).not.toBeNull();
  expect(screen.queryByText(/Earlier failure/)).toBeNull();
});

it('only hides after persisted acknowledgement, stays dismissed on refresh, and shows new outcomes', async () => {
  const { client, create, request } = clientFixture();
  const mounted = render(view(client));
  fireEvent.click(await screen.findByTitle(dismissLabel));
  expect(create).toHaveBeenCalledExactlyOnceWith(
    { operation_id: operation.operation_id },
    { route: { id: branch.branch_id } }
  );
  expect(screen.getByText('Branch cleanup failed')).not.toBeNull();
  expect(screen.getByTitle(dismissLabel).hasAttribute('disabled')).toBe(true);
  await act(async () => request.resolve());
  expect(screen.queryByText('Branch cleanup failed')).toBeNull();
  // Reload/other users receive a branch representation without the payload.
  mounted.unmount();
  const reload = render(view(client, { ...branch, workspace_operation: undefined }));
  expect(screen.queryByText('Branch cleanup failed')).toBeNull();
  reload.rerender(
    view(client, { ...branch, workspace_operation: { ...operation, operation_id: generateId() } })
  );
  expect(await screen.findByTitle(dismissLabel)).not.toBeNull();
  expect(screen.getByText('Branch cleanup failed')).not.toBeNull();
});

it('keeps the notification and retry affordance when saving dismissal fails', async () => {
  const { client, request } = clientFixture();
  render(view(client));
  fireEvent.click(await screen.findByTitle(dismissLabel));
  await act(async () => request.reject(new Error('Permission changed')));
  expect(showError).toHaveBeenCalledWith('Permission changed');
  expect(screen.getByText('Branch cleanup failed')).not.toBeNull();
  expect(screen.getByTitle(dismissLabel).hasAttribute('disabled')).toBe(false);
});

it.each(['accepted', 'running', 'unknown'] as const)(
  'does not offer dismissal for %s',
  (status) => {
    const { client, find } = clientFixture();
    render(
      view(client, {
        ...branch,
        workspace_operation: {
          ...operation,
          status,
          deadline_at: new Date(Date.now() + 60_000).toISOString(),
        },
      })
    );
    expect(screen.queryByTitle(dismissLabel)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  }
);

it('projects a timed-out operation as needs attention, never as a dismissible failure', () => {
  render(view(null, { ...branch, workspace_operation: { ...operation, status: 'running' } }));
  expect(screen.getByText('Branch cleanup needs attention')).not.toBeNull();
  expect(screen.getByText(/Workspace operation stopped reporting/)).not.toBeNull();
  expect(screen.queryByTitle(dismissLabel)).toBeNull();
});

it.each([
  { filesystem_status: 'failed' },
  { deletion_status: 'deletion_failed' },
] as Partial<Branch>[])('retains a notification when the branch is blocked: %j', (state) => {
  const { client, find } = clientFixture();
  render(view(client, { ...branch, ...state }));
  expect(screen.queryByTitle(dismissLabel)).toBeNull();
  expect(find).not.toHaveBeenCalled();
});

it('does not offer dismissal to a non-manager or after a failed permission read', async () => {
  const { client, find } = clientFixture();
  find.mockResolvedValue({ is_owner: false, can: 'session' });
  const mounted = render(view(client));
  await act(async () => {});
  expect(screen.queryByTitle(dismissLabel)).toBeNull();
  find.mockRejectedValue(new Error('Unavailable'));
  mounted.rerender(view(client, branch, 1));
  await act(async () => {});
  expect(screen.queryByTitle(dismissLabel)).toBeNull();
});

it.each(['new operation', 'new auth generation'] as const)(
  'ignores an old response after %s',
  async (change) => {
    const { client, request } = clientFixture();
    const mounted = render(view(client));
    fireEvent.click(await screen.findByTitle(dismissLabel));
    mounted.rerender(
      view(
        client,
        change === 'new operation'
          ? { ...branch, workspace_operation: { ...operation, operation_id: generateId() } }
          : branch,
        change === 'new auth generation' ? 1 : 0
      )
    );
    await act(async () => request.resolve());
    expect(screen.getByText('Branch cleanup failed')).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByTitle(dismissLabel).hasAttribute('disabled')).toBe(false)
    );
  }
);

it('renders completion rather than a permanent error and keeps timestamp in hover details', async () => {
  render(
    view(null, {
      ...branch,
      workspace_operation: { ...operation, status: 'succeeded', error: undefined },
    })
  );
  expect(screen.queryByText(operation.error!)).toBeNull();
  fireEvent.mouseEnter(screen.getByText('Branch cleanup completed'));
  expect((await screen.findByRole('tooltip')).textContent).toContain(operation.finished_at);
});
