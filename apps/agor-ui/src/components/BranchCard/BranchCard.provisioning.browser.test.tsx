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
  'recovers %s through the existing retry route and waits for ready',
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
    await userEvent.click(screen.getByRole('button', { name: /Retry|Recover/ }));
    expect(service).toHaveBeenCalledWith(`branches/${branch.branch_id}/retry-provisioning`);
    expect(create).toHaveBeenCalledWith({});
    // The returned representation is not the card's source of truth: board updates are.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Retry|Recover/ })).not.toBeDisabled()
    );
    mounted.rerender(view({ ...branch, filesystem_status: 'creating' }));
    expect(screen.getByText('Filesystem provisioning in progress')).toBeVisible();
    mounted.rerender(
      view({ ...branch, filesystem_status: 'creating', provisioning_operation: 'restore' })
    );
    expect(screen.getByText('Filesystem recovery in progress')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    mounted.rerender(view({ ...branch, filesystem_status: 'failed' }));
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(create).toHaveBeenCalledTimes(2);
    mounted.rerender(view({ ...branch, filesystem_status: 'ready', error_message: undefined }));
    expect(screen.queryByText('Provisioning failed')).toBeNull();
    expect(screen.queryByText('Filesystem unavailable')).toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    mounted.unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
);
