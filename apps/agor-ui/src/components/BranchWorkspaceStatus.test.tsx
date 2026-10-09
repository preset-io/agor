import { generateId } from '@agor/core/ids/browser';
import type { AgorClient, Branch, BranchWorkspaceOperation } from '@agor-live/client';
import { BRANCH_WORKSPACE_NOTIFICATION_DISMISS_SERVICE } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../contexts/ConnectionContext';
import { makeBranch, makeUser } from './BranchModal/testUtils';
import { BranchWorkspaceStatus, describeWorkspaceOperation } from './BranchWorkspaceStatus';

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
const FAILED = "Agor couldn't clean up this branch's files.";
const dismissButton = () => screen.getByRole('button', { name: /Dismiss/ });
const findDismissButton = () => screen.findByRole('button', { name: /Dismiss/ });
const queryDismissButton = () => screen.queryByRole('button', { name: /Dismiss/ });
beforeEach(() => vi.clearAllMocks());

it('keeps the raw error under Details and ignores historical errors', () => {
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
  expect(screen.getByText(FAILED)).not.toBeNull();
  expect(screen.queryByText(operation.error!)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText(operation.error!)).not.toBeNull();
  expect(screen.queryByText(/Earlier failure/)).toBeNull();
});

it('only hides after persisted acknowledgement, stays dismissed on refresh, and shows new outcomes', async () => {
  const { client, create, request } = clientFixture();
  const mounted = render(view(client));
  fireEvent.click(await findDismissButton());
  expect(create).toHaveBeenCalledExactlyOnceWith(
    { operation_id: operation.operation_id },
    { route: { id: branch.branch_id } }
  );
  expect(screen.getByText(FAILED)).not.toBeNull();
  expect(dismissButton().className).toContain('ant-btn-loading');
  await act(async () => request.resolve());
  expect(screen.queryByText(FAILED)).toBeNull();
  // Reload/other users receive a branch representation without the payload.
  mounted.unmount();
  const reload = render(view(client, { ...branch, workspace_operation: undefined }));
  expect(screen.queryByText(FAILED)).toBeNull();
  reload.rerender(
    view(client, { ...branch, workspace_operation: { ...operation, operation_id: generateId() } })
  );
  expect(await findDismissButton()).not.toBeNull();
  expect(screen.getByText(FAILED)).not.toBeNull();
});

it('keeps the notification and retry affordance when saving dismissal fails', async () => {
  const { client, request } = clientFixture();
  render(view(client));
  fireEvent.click(await findDismissButton());
  await act(async () => request.reject(new Error('Permission changed')));
  expect(showError).toHaveBeenCalledWith('Failed to dismiss the notification: Permission changed');
  expect(screen.getByText(FAILED)).not.toBeNull();
  expect(dismissButton().className).not.toContain('ant-btn-loading');
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
    expect(queryDismissButton()).toBeNull();
    expect(find).not.toHaveBeenCalled();
  }
);

it('projects a timed-out operation as lost track, never as a dismissible failure', () => {
  render(view(null, { ...branch, workspace_operation: { ...operation, status: 'running' } }));
  expect(
    screen.getByText('Agor lost track of this cleanup, so some files may already be gone.')
  ).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(
    screen.getByText(
      'Workspace operation stopped reporting. Its outcome requires reconciliation; do not retry.'
    )
  ).not.toBeNull();
  expect(queryDismissButton()).toBeNull();
});

it.each([
  { filesystem_status: 'failed' },
  { deletion_status: 'deletion_failed' },
] as Partial<Branch>[])('retains a notification when the branch is blocked: %j', (state) => {
  const { client, find } = clientFixture();
  render(view(client, { ...branch, ...state }));
  expect(queryDismissButton()).toBeNull();
  expect(find).not.toHaveBeenCalled();
});

it('does not offer dismissal to a non-manager or after a failed permission read', async () => {
  const { client, find } = clientFixture();
  find.mockResolvedValue({ is_owner: false, can: 'session' });
  const mounted = render(view(client));
  await act(async () => {});
  expect(queryDismissButton()).toBeNull();
  find.mockRejectedValue(new Error('Unavailable'));
  mounted.rerender(view(client, branch, 1));
  await act(async () => {});
  expect(queryDismissButton()).toBeNull();
});

it.each(['new operation', 'new auth generation'] as const)(
  'ignores an old response after %s',
  async (change) => {
    const { client, request } = clientFixture();
    const mounted = render(view(client));
    fireEvent.click(await findDismissButton());
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
    expect(screen.getByText(FAILED)).not.toBeNull();
    await waitFor(() => expect(dismissButton().className).not.toContain('ant-btn-loading'));
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
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  fireEvent.mouseEnter(screen.getByText('Cleanup finished.'));
  expect((await screen.findByRole('tooltip')).textContent).toContain(operation.finished_at);
});

it.each([
  ['clean', 'accepted', 'info', "Agor is cleaning up this branch's files…"],
  ['clean', 'running', 'info', "Agor is cleaning up this branch's files…"],
  ['clean', 'failed', 'error', "Agor couldn't clean up this branch's files."],
  [
    'clean',
    'unknown',
    'warning',
    'Agor lost track of this cleanup, so some files may already be gone.',
  ],
  ['clean', 'succeeded', 'neutral', 'Cleanup finished.'],
  ['archive', 'accepted', 'info', 'Agor is archiving this branch…'],
  ['archive', 'running', 'info', 'Agor is archiving this branch…'],
  ['archive', 'failed', 'error', "Agor couldn't archive this branch's files."],
  [
    'archive',
    'unknown',
    'warning',
    'Agor lost track of this archive, so some files may already be gone.',
  ],
  ['archive', 'succeeded', 'neutral', 'Branch archived.'],
] as const)('describes %s %s', (action, status, type, message) => {
  expect(describeWorkspaceOperation({ ...operation, action, status })).toEqual({ type, message });
});
