import { describe, expect, it } from 'vitest';
import { buildPromptTaskMetadata } from './prompt-task-metadata.js';
import { normalizeMessageSource } from './task-runner.js';

describe('buildPromptTaskMetadata', () => {
  it('drops a stale legacy source and makes normalized provenance authoritative', () => {
    const input = {
      source: 'cli-repl',
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
});
