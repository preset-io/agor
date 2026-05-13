import { describe, expect, it } from 'vitest';
import { shouldHidePersistedClaudeSdkEvent } from './claude-system-suppression';

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
