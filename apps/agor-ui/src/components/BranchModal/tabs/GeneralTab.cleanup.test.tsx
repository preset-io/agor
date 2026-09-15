import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button } from 'antd';
import { expect, it } from 'vitest';
import { makeBranch, makeRepo, makeStubClient, makeUser, wrapper } from '../testUtils';
import { useBranchModalForm } from '../useBranchModalForm';
import { GeneralTab } from './GeneralTab';

it('saves protection with the parent branch form after its section is collapsed', async () => {
  const branch = makeBranch();
  const user = makeUser({ user_id: 'user-1', role: 'member' });
  const { client, calls } = makeStubClient({ users: [user] });
  function Editor() {
    const form = useBranchModalForm({ branch, client, currentUser: user, open: true });
    return (
      <>
        <GeneralTab
          branch={branch}
          repo={makeRepo()}
          sessions={[]}
          canEdit={form.canEditGeneral}
          state={form.general}
          setField={form.setGeneral}
        />
        <Button onClick={() => void form.save()}>Save</Button>
      </>
    );
  }
  render(<Editor />, { wrapper });
  const toggle = screen.getByText('Branch cleanup').closest('[role="button"]') as HTMLElement;
  fireEvent.click(toggle);
  const protection = screen.getByLabelText('Protect this branch from cleanup');
  await waitFor(() => expect(protection).toBeEnabled());
  fireEvent.click(protection);
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() =>
    expect(calls.filter((call) => call.service === 'branches' && call.method === 'patch')).toEqual([
      expect.objectContaining({
        args: [branch.branch_id, expect.objectContaining({ cleanup_protected: true }), undefined],
      }),
    ])
  );
});
