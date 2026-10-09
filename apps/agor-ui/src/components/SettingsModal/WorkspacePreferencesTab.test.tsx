import type { AgorClient, User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePreferencesTab } from './WorkspacePreferencesTab';

const admin = { user_id: 'admin', role: 'admin' } as User;

function renderTab(service: Record<string, unknown>) {
  const client = { service: () => service } as unknown as AgorClient;
  render(
    <AntApp>
      <WorkspacePreferencesTab client={client} currentUser={admin} />
    </AntApp>
  );
}

describe('WorkspacePreferencesTab', () => {
  it('shows a load failure and retries on Try again', async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ session_sharing_enabled: false });
    renderTab({ find, patch: vi.fn() });
    expect(await screen.findByText("Couldn't load workspace preferences.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Session sharing')).toBeInTheDocument();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('toasts a save failure with the raw error', async () => {
    const find = vi.fn().mockResolvedValue({ session_sharing_enabled: false });
    const patch = vi.fn().mockRejectedValue(new Error('boom'));
    renderTab({ find, patch });
    fireEvent.click(await screen.findByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText("Couldn't save workspace preferences. (boom)")
    ).toBeInTheDocument();
  });
});
