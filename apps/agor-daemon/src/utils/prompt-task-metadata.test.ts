import { describe, expect, it } from 'vitest';
import { buildPromptTaskMetadata } from './prompt-task-metadata.js';

describe('buildPromptTaskMetadata', () => {
  it('drops a stale legacy source and makes normalized provenance authoritative', () => {
    const input = {
      source: 'cli-repl',
      system_authored: true,
      queued_by_user_id: 'spoofed-user',
    } as unknown as Parameters<typeof buildPromptTaskMetadata>[0];

    expect(buildPromptTaskMetadata(input, 'gateway', 'actual-user')).toEqual({
      system_authored: true,
      queued_by_user_id: 'actual-user',
      source: 'gateway',
    });
  });

  it('does not persist an untrusted source when no current source was resolved', () => {
    const input = { source: 'cli-repl' } as unknown as Parameters<
      typeof buildPromptTaskMetadata
    >[0];
    expect(buildPromptTaskMetadata(input, undefined)).toEqual({});
  });
});
