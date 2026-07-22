import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  mapSdkActivity,
  reportSdkActivity,
  SDK_ACTIVITY_VERSION_MANIFEST,
} from '../sdk-watchdog.js';

describe('SDK activity mapping', () => {
  it.each([
    ['claude-code', 'assistant'],
    ['codex', 'item.started'],
    ['gemini', 'content'],
    ['copilot', 'assistant.message_delta'],
    ['opencode', 'message.part.updated'],
  ] as const)('%s maps healthy activity to progress', (adapter, event) => {
    expect(mapSdkActivity(adapter, event)).toEqual({ kind: 'progress', detail: event });
  });

  it('does not treat the observed Codex initialization signature as progress', () => {
    expect(mapSdkActivity('codex', 'event_msg.turn_context')).toEqual({
      kind: 'sdk_started',
      detail: 'event_msg.turn_context',
    });
  });

  it.each([
    ['claude-code', 'future.event'],
    ['codex', 'future.event'],
    ['gemini', 'future.event'],
    ['copilot', 'future.event'],
    ['opencode', 'future.event'],
  ] as const)('%s keeps unknown activity visible but non-progressing', (adapter, event) => {
    expect(mapSdkActivity(adapter, event)).toEqual({
      kind: 'unknown_activity',
      detail: event,
    });
  });

  it('ignores OpenCode transport heartbeats and bounds diagnostic detail', () => {
    expect(mapSdkActivity('opencode', 'server.heartbeat')).toBeUndefined();
    const pulse = mapSdkActivity('codex', `bad secret ${'x'.repeat(200)}`);
    expect(pulse?.detail).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(pulse?.detail.length).toBe(128);
  });

  it('invokes one in-memory callback without retaining raw payloads', () => {
    const callback = vi.fn();
    reportSdkActivity(callback, 'claude-code', 'assistant');
    expect(callback).toHaveBeenCalledWith('progress', 'assistant');
  });
});

describe('SDK activity version manifest', () => {
  it('matches every reviewed resolved dependency version', () => {
    const lockfile = readFileSync(new URL('../../../../pnpm-lock.yaml', import.meta.url), 'utf8');
    expect(Object.keys(SDK_ACTIVITY_VERSION_MANIFEST).sort()).toEqual(
      ['claude-code', 'codex', 'gemini', 'copilot', 'opencode'].sort()
    );
    for (const dependency of Object.values(SDK_ACTIVITY_VERSION_MANIFEST)) {
      expect(lockfile).toContain(`'${dependency}':`);
    }
  });
});
