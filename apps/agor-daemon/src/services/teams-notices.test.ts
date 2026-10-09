import { TeamsSendError } from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { TeamsSendConnector } from '../utils/teams-connector-cache.js';
import { sendTeamsNotice, sendTeamsTyping } from './teams-notices.js';

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
  const typingMock = vi.fn(async () => undefined);
  const connector: TeamsSendConnector = {
    prepareSend: vi.fn(async () => ({ send: sendMock, sendTyping: typingMock })),
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
  return { connector, addresses, sendMock, typingMock };
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

  it('sends typing through the same fenced address, also with proactive sends off', async () => {
    const { connector, addresses, sendMock, typingMock } = setup();
    await expect(
      sendTeamsTyping({ channel, threadId: 'a:personal', addresses, connector: () => connector })
    ).resolves.toBe('sent');
    expect(addresses.loadFenced).toHaveBeenCalledWith({ channel, threadId: 'a:personal' });
    expect(typingMock).toHaveBeenCalledOnce();
    expect(sendMock).not.toHaveBeenCalled();

    const quiet = {
      ...channel,
      config: { ...(channel.config as Record<string, unknown>), outbound_enabled: false },
    } as GatewayChannel;
    // outbound_enabled opts in to proactive posts only; replies, notices, and typing stay on.
    for (const send of [sendTeamsTyping, sendTeamsNotice]) {
      await expect(
        send({
          channel: quiet,
          threadId: 'a:personal',
          text: 'x',
          addresses,
          connector: () => connector,
        })
      ).resolves.toBe('sent');
    }
    expect(addresses.loadFenced).toHaveBeenCalledTimes(3);
  });
});
