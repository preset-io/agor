import { TeamsSendError } from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { TeamsSendConnector } from '../utils/teams-connector-cache.js';
import { sendTeamsNotice } from './teams-notices.js';

const channel = {
  id: 'channel-1',
  channel_type: 'teams',
  enabled: true,
  provider_installation_id: 'teams-app',
  provider_config_generation: 2,
  config: { app_id: 'teams-app', microsoft_tenant_id: 'entra', outbound_enabled: true },
} as unknown as GatewayChannel;

function setup(send: (text: string) => Promise<string> = async () => 'notice-1') {
  const sendMock = vi.fn(send);
  const connector: TeamsSendConnector = {
    prepareSend: vi.fn(async () => ({ send: sendMock })),
    invalidateTokens: vi.fn(),
    formatMessage: (text: string) => text,
  };
  const addresses = {
    loadFenced: vi.fn(async () => ({
      ok: true as const,
      row: {} as never,
      address: { serviceUrl: 'https://smba.trafficmanager.net/teams/' },
    })),
    revokeThread: vi.fn(async () => 1),
  };
  return { connector, addresses, sendMock };
}

describe('sendTeamsNotice', () => {
  it('sends one notice through the fenced address', async () => {
    const { connector, addresses, sendMock } = setup();
    await expect(
      sendTeamsNotice({
        channel,
        threadId: 'a:personal',
        text: 'Not linked',
        addresses,
        connector: () => connector,
      })
    ).resolves.toBe('sent');
    expect(addresses.loadFenced).toHaveBeenCalledWith({ channel, threadId: 'a:personal' });
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0]).toBe('Not linked');
  });

  it('skips without a usable address and never throws on provider failure', async () => {
    const skipped = setup();
    skipped.addresses.loadFenced.mockResolvedValueOnce({
      ok: false,
      code: 'conversation_address_revoked',
    } as never);
    await expect(
      sendTeamsNotice({
        channel,
        threadId: 'a:personal',
        text: 'x',
        addresses: skipped.addresses,
        connector: () => skipped.connector,
      })
    ).resolves.toBe('skipped');
    expect(skipped.connector.prepareSend).not.toHaveBeenCalled();

    const revoked = setup(async () => {
      throw new TeamsSendError({
        phase: 'send',
        status: 403,
        providerCode: 'ConversationBlockedByUser',
      });
    });
    await expect(
      sendTeamsNotice({
        channel,
        threadId: 'a:personal',
        text: 'x',
        addresses: revoked.addresses,
        connector: () => revoked.connector,
      })
    ).resolves.toBe('failed');
    expect(revoked.addresses.revokeThread).toHaveBeenCalledWith(
      'channel-1',
      'a:personal',
      'conversation_blocked'
    );
  });
});
