/**
 * Gateway prompt identity — fail-closed tests.
 *
 * The property: a Session whose prompts are attributed to a shared channel
 * account must never be reported as aligned, because a credential minted from
 * such a prompt belongs to that one account and is drivable by everyone in the
 * channel. Every uncertain answer therefore has to be "not aligned".
 */

import type { ChannelType, Session } from '@agor/core/types';
import { GATEWAY_USER_ALIGNMENT_CONFIG_KEYS } from '@agor/core/types';
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

const gatewaySession = (channelType: ChannelType) =>
  ({
    custom_context: {
      gateway_source: {
        channel_id: 'chan-1',
        channel_name: 'ops',
        channel_type: channelType,
        thread_id: 't1',
      },
    },
  }) as unknown as Session;

const teamsSession = gatewaySession('teams');
const shortcutSession = gatewaySession('shortcut');

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

  it('is NOT aligned for a platform with no alignment switch', async () => {
    // Teams is inbound via webhook and a Teams channel is multi-member, but it
    // has no alignment flag at all — so `gateway.ts` falls through to
    // `user = channel.agor_user_id` unconditionally. An earlier version of this
    // guard read "no switch" as "no shared-account fallback to be caught by",
    // which is the opposite of what the gateway actually does.
    const verdict = await resolveGatewayPromptIdentity(teamsSession, channel({}));
    expect(verdict.aligned).toBe(false);
    // Nothing to name: there is no setting an admin could turn on.
    expect(verdict.configKey).toBeUndefined();
    expect(verdict.source?.channel_type).toBe('teams');
  });

  it('is NOT aligned for shortcut until its own flag is on', async () => {
    // Shortcut DOES have `align_shortcut_users` (gateway.ts reads it), but the
    // guard used to omit it from its map, so `configKey` was undefined and the
    // "no switch" branch reported it aligned — with the flag off, every
    // Shortcut comment prompts as the channel's shared account.
    const off = await resolveGatewayPromptIdentity(shortcutSession, channel({}));
    expect(off).toMatchObject({ aligned: false, configKey: 'align_shortcut_users' });

    const on = await resolveGatewayPromptIdentity(
      shortcutSession,
      channel({ align_shortcut_users: true })
    );
    expect(on.aligned).toBe(true);
  });

  it('refuses a channel type that has no entry in the alignment map at all', async () => {
    // THE property, stated without reference to today's list: alignment is an
    // allowlist. A ChannelType added to the gateway without wiring up real
    // per-user attribution must be refused by default, not admitted because
    // nobody remembered to add it here.
    const unlisted = (
      ['slack', 'discord', 'whatsapp', 'telegram', 'github', 'teams', 'shortcut'] as const
    ).filter((type) => !(type in GATEWAY_USER_ALIGNMENT_CONFIG_KEYS));
    expect(unlisted.length).toBeGreaterThan(0);

    for (const channelType of unlisted) {
      const verdict = await resolveGatewayPromptIdentity(
        gatewaySession(channelType),
        // A permissive config cannot rescue it: with no key to read there is
        // nothing that could be `=== true`.
        channel({ align_slack_users: true, aligned: true })
      );
      expect(verdict.aligned, `${channelType} must fail closed`).toBe(false);
    }
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

  it('names no setting when the platform has none, rather than inventing one', async () => {
    const verdict = await resolveGatewayPromptIdentity(teamsSession, channel({}));
    const message = gatewayIdentityRefusalMessage(verdict);
    expect(message).toContain('ops');
    expect(message).not.toMatch(/align_\w+/);
    expect(message).toMatch(/Agor canvas/);
  });
});
