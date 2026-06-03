import { describe, expect, it } from 'vitest';
import {
  shouldHidePersistedClaudeSdkEvent,
  shouldSuppressClaudeSystemEvent,
} from './claude-system-suppression';

describe('shouldHidePersistedClaudeSdkEvent', () => {
  it('hides task_updated rows (including ones with patch.error)', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'task_updated',
        metadata: { subtype: 'task_updated', patch: { status: 'failed', error: 'boom' } },
      })
    ).toBe(true);
  });

  it('hides hook lifecycle rows that only describe hook plumbing', () => {
    for (const sdkSubtype of ['hook_started', 'hook_progress', 'hook_response']) {
      expect(
        shouldHidePersistedClaudeSdkEvent({
          type: 'sdk_event',
          sdkType: 'system',
          sdkSubtype,
          metadata: { subtype: sdkSubtype, hook_event_name: 'PreToolUse' },
        })
      ).toBe(true);
    }
  });

  it('keeps failed hook_response rows visible for diagnostics', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'hook_response',
        metadata: { subtype: 'hook_response', outcome: 'error', stderr: 'hook failed' },
      })
    ).toBe(false);

    expect(
      shouldSuppressClaudeSystemEvent({
        subtype: 'hook_response',
        exit_code: 2,
        stdout: '',
        stderr: 'hook failed',
      })
    ).toBe(false);
  });

  it('treats non-zero hook_response exit_code as diagnostic even if outcome says success', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'hook_response',
        metadata: {
          subtype: 'hook_response',
          outcome: 'success',
          exit_code: 1,
          stderr: 'hook failed after reporting success',
        },
      })
    ).toBe(false);
  });

  it('hides thinking token telemetry rows', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'thinking_tokens',
        metadata: { subtype: 'thinking_tokens', thinking_tokens: 1234 },
      })
    ).toBe(true);
  });

  it('hides status=requesting rows via the metadata path', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'status',
        metadata: { subtype: 'status', status: 'requesting' },
      })
    ).toBe(true);
  });

  it('lets user-meaningful subtypes through (e.g. mirror_error)', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'mirror_error',
        metadata: { subtype: 'mirror_error', error: 'disk full' },
      })
    ).toBe(false);
  });

  it('lets status=compacting fall through (the executor renders it as a real SYSTEM message)', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'status',
        metadata: { subtype: 'status', status: 'compacting' },
      })
    ).toBe(false);
  });

  it('does not match non-system sdkType', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'tool_progress',
        sdkSubtype: 'task_updated',
      })
    ).toBe(false);
  });

  it('does not match non-sdk_event blocks', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'rate_limit',
        sdkType: 'system',
        sdkSubtype: 'task_updated',
      })
    ).toBe(false);
  });

  it('tolerates missing metadata on status rows', () => {
    expect(
      shouldHidePersistedClaudeSdkEvent({
        type: 'sdk_event',
        sdkType: 'system',
        sdkSubtype: 'status',
      })
    ).toBe(false);
  });
});
