import { generateId } from '@agor/core/ids/browser';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BranchModal } from './BranchModal';
import { makeBranch, makeRepo, makeStubClient, makeUser, renderWithApp } from './testUtils';

beforeEach(() => agorStore.setState({ ...EMPTY_MAPS }));
afterEach(() => agorStore.setState({ ...EMPTY_MAPS }));

it('updates snapshot-modal notifications from branch events without resetting form drafts', async () => {
  const user = makeUser();
  const branch = makeBranch({
    filesystem_status: 'ready',
    workspace_operation: {
      operation_id: generateId(),
      action: 'clean',
      filesystem_action: 'cleaned',
      status: 'succeeded',
      requested_by: user.user_id,
      requested_at: '2026-10-08T00:00:00Z',
      deadline_at: '2026-10-08T00:06:00Z',
      finished_at: '2026-10-08T00:01:00Z',
    },
  });
  agorStore.setState({ branchById: new Map([[branch.branch_id, branch]]) });
  renderWithApp(
    <BranchModal
      open
      onClose={() => {}}
      branch={branch}
      repo={makeRepo()}
      sessions={[]}
      currentUser={user}
      client={
        makeStubClient({ owners: [user], effectiveAccess: { is_owner: true, can: 'all' } }).client
      }
    />
  );
  const notes = screen.getByPlaceholderText<HTMLTextAreaElement>(
    'Freeform notes about this branch...'
  );
  await waitFor(() => expect(notes.disabled).toBe(false));
  fireEvent.change(notes, { target: { value: 'Unsaved draft' } });
  expect(screen.getByText('Branch cleanup completed')).not.toBeNull();

  // The canonical branch patch arrives after another manager dismisses it;
  // the modal's original branch prop deliberately stays unchanged.
  act(() => {
    agorStore.setState({
      branchById: new Map([[branch.branch_id, { ...branch, workspace_operation: undefined }]]),
    });
  });
  expect(screen.queryByText('Branch cleanup completed')).toBeNull();
  expect(notes.value).toBe('Unsaved draft');

  act(() => {
    agorStore.setState({
      branchById: new Map([
        [
          branch.branch_id,
          {
            ...branch,
            workspace_operation: {
              ...branch.workspace_operation!,
              operation_id: generateId(),
              status: 'failed',
              error: 'New failure',
            },
          },
        ],
      ]),
    });
  });
  expect(screen.getByText('Branch cleanup failed')).not.toBeNull();
  expect(screen.getByText('New failure')).not.toBeNull();
  expect(notes.value).toBe('Unsaved draft');
});
