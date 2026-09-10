import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ArchiveDeleteBranchModal } from '../ArchiveDeleteBranchModal/ArchiveDeleteBranchModal';
import { BranchStorageControl } from './BranchStorageControl';

const { config } = vi.hoisted(() => ({ config: { enabled: false } }));
vi.mock('../../hooks/useAuthConfig', () => ({
  useAuthConfig: () => ({
    featuresConfig: {
      branchStorage: { coldStorageEnabled: config.enabled },
    },
  }),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));
afterEach(() => {
  config.enabled = false;
});
const branch = { branch_id: 'fixture', name: 'Fixture', storage_mode: 'clone' } as Branch;

it('hides new cooling while disabled but keeps cold status and Restore usable', async () => {
  const create = vi.fn().mockResolvedValue({});
  const client = { service: vi.fn(() => ({ create })) } as unknown as AgorClient;
  const { rerender } = render(<BranchStorageControl branch={branch} client={client} />);
  expect(screen.queryByRole('button')).toBeNull();
  rerender(
    <BranchStorageControl
      branch={{ ...branch, workspace_storage: { residency: 'cold' } }}
      client={client}
    />
  );
  expect(screen.getByText(/In cold storage/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ action: 'restore' }));
  expect(client.service).toHaveBeenCalledWith('branches/fixture/storage');
});

it('shows actual phase and an explicit settled-failure recovery action', () => {
  const { rerender } = render(
    <BranchStorageControl
      client={null}
      branch={{ ...branch, workspace_storage: { residency: 'warming', phase: 'restoring' } }}
    />
  );
  expect(screen.getByText('Downloading and verifying')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  rerender(
    <BranchStorageControl
      client={null}
      branch={{
        ...branch,
        workspace_storage: {
          residency: 'warming',
          phase: 'publishing',
          error: 'Interrupted',
          retryable: true,
        },
      }}
    />
  );
  expect(screen.getByText('Needs attention')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
});

it('archive defaults to whole-workspace cooling only when enabled and supported', async () => {
  config.enabled = true;
  const confirm = vi.fn();
  render(<ArchiveDeleteBranchModal open branch={branch} onConfirm={confirm} onCancel={() => {}} />);
  expect(
    screen.getByRole('checkbox', { name: /Also move workspace to cold storage/ })
  ).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Archive Branch' }));
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith({
      metadataAction: 'archive',
      filesystemAction: 'preserved',
      coolWorkspace: true,
    })
  );
});
