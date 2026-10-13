import type { Branch, Repo } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import BranchCard from './BranchCard';

afterEach(cleanup);

it.each(['failed', 'cleaned', 'preserved', 'deleted'] as const)(
  'restores %s through the existing retry route and waits for ready',
  async (status) => {
    const branch = {
      branch_id: 'fictional-branch',
      repo_id: 'fictional-repo',
      name: 'Fictional branch',
      filesystem_status: status,
      error_message: 'Fictional launcher unavailable',
    } as Branch;
    const create = vi.fn(async () => ({ ...branch, filesystem_status: 'creating' }));
    const service = vi.fn(() => ({ create }));
    const client = { service } as unknown as ComponentProps<typeof BranchCard>['client'];
    const view = (row: Branch) => (
      <App>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            authGeneration: 0,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <BranchCard
            branch={row}
            repo={{ repo_id: branch.repo_id, slug: 'fictional/repo' } as Repo}
            sessions={[]}
            userById={new Map()}
            client={client}
            panelMode
          />
        </ConnectionProvider>
      </App>
    );
    const mounted = render(view(branch));
    await userEvent.click(screen.getByRole('button', { name: /^(Try again|Restore files)$/ }));
    expect(service).toHaveBeenCalledWith(`branches/${branch.branch_id}/retry-provisioning`);
    expect(create).toHaveBeenCalledWith({});
    // The returned representation is not the card's source of truth: board updates are.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^(Try again|Restore files)$/ })).not.toBeDisabled()
    );
    mounted.rerender(view({ ...branch, filesystem_status: 'creating' }));
    expect(screen.getByText('Agor is setting up this branch…')).toBeVisible();
    mounted.rerender(
      view({ ...branch, filesystem_status: 'creating', provisioning_operation: 'restore' })
    );
    expect(screen.getByText("Agor is restoring this branch's files…")).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    mounted.rerender(view({ ...branch, filesystem_status: 'failed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(create).toHaveBeenCalledTimes(2);
    mounted.rerender(view({ ...branch, filesystem_status: 'ready', error_message: undefined }));
    expect(screen.queryByText("Agor couldn't set up this branch.", { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    mounted.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
);

it('keeps only the status Details usable on an offline card', async () => {
  const branch = {
    branch_id: 'fictional-branch',
    repo_id: 'fictional-repo',
    name: 'Fictional branch',
    filesystem_status: 'failed',
    error_message: 'Fictional launcher unavailable',
  } as Branch;
  render(
    <App>
      <ConnectionProvider
        value={{
          connected: false,
          connecting: false,
          authGeneration: 0,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <BranchCard
          branch={branch}
          repo={{ repo_id: branch.repo_id, slug: 'fictional/repo' } as Repo}
          sessions={[]}
          userById={new Map()}
          client={{ service: vi.fn() } as unknown as ComponentProps<typeof BranchCard>['client']}
        />
      </ConnectionProvider>
    </App>
  );
  const notice = screen.getByText(
    "Agor couldn't set up this branch. Sessions can't start until it's set up."
  );
  expect(notice.closest('.ant-card')).toHaveStyle({ pointerEvents: 'none' });
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Details/ }));
  expect(await screen.findByText('Fictional launcher unavailable')).toBeVisible();
});
