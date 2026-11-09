import type { Repo } from '@agor-live/client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ReposTable } from './ReposTable';
import { renderWithSettingsShell } from './settingsDrillTestUtils';

afterEach(cleanup);

const failedRepo = {
  repo_id: 'repo-failed',
  name: 'Payments',
  slug: 'acme/payments',
  default_branch: 'develop',
  repo_type: 'remote',
  remote_url: 'https://github.com/acme/payments.git',
  clone_status: 'failed',
  clone_generation: 2,
  clone_error: { exit_code: 128, category: 'unknown', message: 'Synthetic clone failure' },
} as Repo;

describe('ReposTable member view', () => {
  it('shows a read-only drill-in with Retry setup and no destructive actions', async () => {
    const onCreate = vi.fn(async () => undefined);
    const onUpdate = vi.fn();
    const view = (repo: Repo) => (
      <ReposTable
        repoById={new Map([[repo.repo_id, repo]])}
        identityKey="member:member"
        operationScope={['member:member', 1]}
        onCreate={onCreate}
        onUpdate={onUpdate}
      />
    );
    const rendered = renderWithSettingsShell(view(failedRepo));

    const deleteButton = await screen.findByRole('button', { name: 'delete' });
    expect(deleteButton).toBeDisabled();
    await userEvent.hover(deleteButton);
    await expect
      .poll(() => screen.queryByText('Only administrators can delete repositories'))
      .toBeVisible();
    await userEvent.unhover(deleteButton);

    await userEvent.click(screen.getByRole('button', { name: 'edit' }));
    const branch = await screen.findByLabelText('Default Branch');
    await waitFor(() => expect(branch).toHaveValue('develop'));
    expect(branch).toBeDisabled();
    expect(screen.getByText('Only administrators can change repository settings.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry setup' }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        {
          url: 'https://github.com/acme/payments.git',
          slug: 'acme/payments',
          default_branch: 'develop',
        },
        expect.any(Function)
      )
    );

    // Reopening reseeds from the stored row; a drill-in never keeps a stale draft.
    rendered.rerender(view({ ...failedRepo, default_branch: 'release' }));
    expect(branch).toHaveValue('develop');
    await userEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'edit' }));
    await waitFor(() => expect(screen.getByLabelText('Default Branch')).toHaveValue('release'));
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
