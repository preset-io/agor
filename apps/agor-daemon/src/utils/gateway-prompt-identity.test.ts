/**
 * Gateway prompt identity — fail-closed tests.
 *
 * The property: a Session whose prompts are attributed to a shared channel
 * account must never be reported as aligned, because a credential minted from
 * such a prompt belongs to that one account and is drivable by everyone in the
 * channel. Every uncertain answer therefore has to be "not aligned".
 */

import type { Session } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  gatewayIdentityRefusalMessage,
  resolveGatewayPromptIdentity,
} from './gateway-prompt-identity.js';

const slackSession = {
  custom_context: {
    gateway_source: {
      channel_id: 'chan-1',
      channel_name: 'eng-help',
      channel_type: 'slack',
      thread_id: 't1',
    },
  },
} as unknown as Session;

const channel = (config: Record<string, unknown>) => async () => ({
  channel_type: 'slack',
  config,
});

describe('resolveGatewayPromptIdentity', () => {
  it('treats a non-gateway session as aligned without loading any channel', async () => {
    const load = vi.fn();
    const verdict = await resolveGatewayPromptIdentity({ custom_context: {} } as Session, load);
    expect(verdict.aligned).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it('is aligned when the channel aligns platform users', async () => {
    const verdict = await resolveGatewayPromptIdentity(
      slackSession,
      channel({ align_slack_users: true })
    );
    expect(verdict.aligned).toBe(true);
  });

  it('is NOT aligned when the flag is off, and names the switch', async () => {
    const verdict = await resolveGatewayPromptIdentity(
      slackSession,
      channel({ align_slack_users: false })
    );
    expect(verdict).toMatchObject({ aligned: false, configKey: 'align_slack_users' });
    expect(verdict.source?.channel_name).toBe('eng-help');
  });

  it('is NOT aligned when the flag is simply absent', async () => {
    const verdict = await resolveGatewayPromptIdentity(slackSession, channel({}));
    expect(verdict.aligned).toBe(false);
  });

  it('is NOT aligned for a truthy-but-not-true value — the gateway compares === true', async () => {
    const verdict = await resolveGatewayPromptIdentity(
      slackSession,
      channel({ align_slack_users: 'yes' })
    );
    expect(verdict.aligned).toBe(false);
  });

  it('is NOT aligned when the channel is missing or unreadable', async () => {
    const missing = await resolveGatewayPromptIdentity(slackSession, async () => null);
    expect(missing.aligned).toBe(false);

    // A read that threw proves nothing either way, and "proves nothing" has to
    // land on the refusing side.
    const unreadable = await resolveGatewayPromptIdentity(slackSession, async () => {
      throw new Error('channel read failed');
    });
    expect(unreadable.aligned).toBe(false);
  });

  it('ignores a malformed gateway_source rather than trusting it', async () => {
    const verdict = await resolveGatewayPromptIdentity(
      { custom_context: { gateway_source: { channel_id: 'c' } } } as unknown as Session,
      channel({})
    );
    // `getGatewaySource` rejects the partial record, so there is no gateway
    // attribution to be caught by — this is an ordinary session.
    expect(verdict.aligned).toBe(true);
  });

  it('treats a platform with no alignment switch as aligned', async () => {
    const teamsSession = {
      custom_context: {
        gateway_source: {
          channel_id: 'chan-1',
          channel_name: 'ops',
          channel_type: 'teams',
          thread_id: 't1',
        },
      },
    } as unknown as Session;
    const verdict = await resolveGatewayPromptIdentity(teamsSession, channel({}));
    expect(verdict.aligned).toBe(true);
  });
});

describe('gatewayIdentityRefusalMessage', () => {
  it('is relayable: names the channel, the consequence, and the fix', async () => {
    const verdict = await resolveGatewayPromptIdentity(
      slackSession,
      channel({ align_slack_users: false })
    );
    const message = gatewayIdentityRefusalMessage(verdict);
    expect(message).toContain('eng-help');
    expect(message).toContain('align_slack_users');
    expect(message).toMatch(/whole\s+channel/);
  });
});
