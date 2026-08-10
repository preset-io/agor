import type { GatewayTaskOrigin } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildPromptTaskMetadata, normalizeMessageSource } from './prompt-task-metadata.js';

describe('buildPromptTaskMetadata', () => {
  it('drops a stale legacy source and makes normalized provenance authoritative', () => {
    const input = {
      source: 'cli-repl',
      gateway_origin: {
        mapping_id: 'spoofed-map',
        channel_id: 'spoofed-channel',
        thread_id: 'spoofed-thread',
      },
      system_authored: true,
      queued_by_user_id: 'spoofed-user',
      initial_message_id: 'spoofed-message-id',
    } as unknown as Parameters<typeof buildPromptTaskMetadata>[0];

    expect(
      buildPromptTaskMetadata(input, 'gateway', 'actual-user', {
        trustedInternalMetadata: true,
      })
    ).toEqual({
      system_authored: true,
      queued_by_user_id: 'actual-user',
      source: 'gateway',
    });
  });

  it('does not persist an untrusted source when no current source was resolved', () => {
    const input = { source: 'cli-repl' } as unknown as Parameters<
      typeof buildPromptTaskMetadata
    >[0];
    expect(
      buildPromptTaskMetadata(input, undefined, undefined, {
        trustedInternalMetadata: true,
      })
    ).toEqual({});
  });

  it('drops every daemon-owned provenance field for an external caller', () => {
    const input = {
      is_agor_callback: true,
      callback_dispatches: [{ event: 'session_completion' }],
      child_session_id: 'child-session',
      child_task_id: 'child-task',
      queued_by_user_id: 'spoofed-user',
      system_authored: true,
      widget_id: 'spoofed-widget',
      widget_resolved_by_user_id: 'spoofed-resolver',
      source: 'gateway',
      initial_message_id: 'spoofed-message',
      completion_callback: {
        target_session_id: 'attacker-session',
        requested_from_session_id: 'attacker-session',
        requested_by_user_id: 'attacker',
      },
    } as unknown as Parameters<typeof buildPromptTaskMetadata>[0];

    expect(
      buildPromptTaskMetadata(input, 'agor', 'authenticated-user', {
        trustedInternalMetadata: false,
      })
    ).toEqual({
      queued_by_user_id: 'authenticated-user',
      source: 'agor',
    });
  });

  it('persists server-derived provenance when an external prompt spoofs gateway source', () => {
    const source = normalizeMessageSource('gateway', { provider: 'rest' });

    expect(
      buildPromptTaskMetadata(undefined, source, 'authenticated-user', {
        trustedInternalMetadata: false,
      })
    ).toEqual({
      queued_by_user_id: 'authenticated-user',
      source: 'agor',
    });
  });

  it('persists only the gateway origin captured by trusted daemon ingress', () => {
    const gatewayOrigin = {
      mapping_id: 'mapping-1' as GatewayTaskOrigin['mapping_id'],
      channel_id: 'channel-1' as GatewayTaskOrigin['channel_id'],
      thread_id: 'thread-1',
    } satisfies GatewayTaskOrigin;

    expect(
      buildPromptTaskMetadata(undefined, 'gateway', 'gateway-user', {
        trustedInternalMetadata: true,
        gatewayOrigin,
      })
    ).toMatchObject({
      source: 'gateway',
      queued_by_user_id: 'gateway-user',
      gateway_origin: gatewayOrigin,
    });
  });
});

describe('normalizeMessageSource', () => {
  it('passes valid sources and sanitizes invalid transport input', () => {
    expect(normalizeMessageSource('gateway', { provider: 'rest' })).toBe('agor');
    expect(normalizeMessageSource('bogus' as 'agor', { provider: 'rest' })).toBe('agor');
    expect(normalizeMessageSource('bogus' as 'agor', {})).toBeUndefined();
  });
});
