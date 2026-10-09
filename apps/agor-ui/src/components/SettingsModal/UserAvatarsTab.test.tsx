import type { AgorClient, UserAvatarSettings } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { UserAvatarsTab } from './UserAvatarsTab';

describe('UserAvatarsTab authority fencing', () => {
  it('does not apply an old auth-generation settings read', async () => {
    let resolve!: (value: UserAvatarSettings) => void;
    const oldRead = new Promise<UserAvatarSettings>((done) => {
      resolve = done;
    });
    const getAvatarSettings = vi
      .fn()
      .mockImplementationOnce(() => oldRead)
      .mockResolvedValueOnce({ enabled: false, provider: null, gateway_channel_id: null });
    const client = {
      service: (path: string) => {
        if (path !== 'users') throw new Error(path);
        return {
          getAvatarSettings,
          updateAvatarSettings: vi.fn(),
          syncAvatars: vi.fn(),
        };
      },
    } as unknown as AgorClient;
    const view = (generation: number) => (
      <AntApp>
        <UserAvatarsTab
          client={client}
          gatewayChannelById={new Map()}
          identityKey="admin-a:admin"
          operationScope={['admin-a:admin', generation]}
        />
      </AntApp>
    );
    const rendered = render(view(1));
    await waitFor(() => expect(getAvatarSettings).toHaveBeenCalledTimes(1));
    rendered.rerender(view(2));
    await waitFor(() => expect(getAvatarSettings).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolve({
        enabled: true,
        provider: 'slack',
        gateway_channel_id: 'old-private-gateway',
      });
      await oldRead;
    });

    expect(
      screen.getByRole('checkbox', { name: /Enable Slack-synced avatars/i })
    ).not.toBeChecked();
  });
});

describe('UserAvatarsTab failures', () => {
  it('shows a load failure inline and retries on Try again', async () => {
    const getAvatarSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ enabled: true, provider: 'slack', gateway_channel_id: null });
    const client = {
      service: () => ({ getAvatarSettings, updateAvatarSettings: vi.fn(), syncAvatars: vi.fn() }),
    } as unknown as AgorClient;
    render(
      <AntApp>
        <UserAvatarsTab
          client={client}
          gatewayChannelById={new Map()}
          identityKey="admin-a:admin"
          operationScope={['admin-a:admin', 1]}
        />
      </AntApp>
    );
    expect(await screen.findByText("Couldn't load avatar settings.")).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Try again' }).click());
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /Enable Slack-synced avatars/i })).toBeChecked()
    );
    expect(screen.queryByText("Couldn't load avatar settings.")).toBeNull();
  });
});
