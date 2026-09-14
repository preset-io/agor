import type { RepoCleanupPolicy } from '@agor-live/client';
import { DEFAULT_REPO_CLEANUP_POLICY } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button, Form } from 'antd';
import { expect, it, vi } from 'vitest';
import { RepoCleanupPolicyFields } from './RepoCleanupPolicyFields';

function editor(policy?: RepoCleanupPolicy) {
  const saved = vi.fn();
  render(
    <Form initialValues={policy ? { cleanup_policy: policy } : undefined} onFinish={saved}>
      <RepoCleanupPolicyFields />
      <Button htmlType="submit">Save</Button>
    </Form>
  );
  return saved;
}

it.each([undefined, { enabled: true, command: './saved.sh', allow_branch_protection: false }])(
  'submits complete defaults or existing policy without ever opening the section (%j)',
  async (policy) => {
    const saved = editor(policy);
    expect(screen.getByRole('button', { name: /Branch cleanup/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ cleanup_policy: policy ?? DEFAULT_REPO_CLEANUP_POLICY })
    );
  }
);

it('retains edited command and toggles through collapse, reopen, and collapsed Save', async () => {
  const saved = editor({ enabled: true, command: './original.sh', allow_branch_protection: false });
  const toggle = screen.getByRole('button', { name: /Branch cleanup/ });
  fireEvent.click(toggle);
  fireEvent.change(screen.getByLabelText('Cleanup command'), { target: { value: './edited.sh' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Allow branch protection' }));
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect(screen.getByLabelText('Cleanup command')).toHaveValue('./edited.sh');
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(saved).toHaveBeenCalledWith({
      cleanup_policy: { enabled: true, command: './edited.sh', allow_branch_protection: true },
    })
  );
});

it('validates fields even while never opened and reveals errors instead of saving hidden invalid configuration', async () => {
  const saved = editor({ enabled: true, command: '', allow_branch_protection: true });
  const toggle = screen.getByRole('button', { name: /Branch cleanup/ });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
  expect(
    await screen.findByText('Enter a command before enabling cleanup (no NUL characters).')
  ).toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Cleanup command'), { target: { value: './valid.sh' } });
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(saved).toHaveBeenCalledWith({
      cleanup_policy: { enabled: true, command: './valid.sh', allow_branch_protection: true },
    })
  );
});
