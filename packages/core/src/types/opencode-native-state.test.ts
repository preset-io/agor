import { describe, expect, it } from 'vitest';
import { isOpenCodeNativeStateAttempt } from './opencode-native-state';

const valid = {
  version: 1,
  attemptTaskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
  digest: `sha256:${'a'.repeat(64)}`,
  bytes: 167936,
  openCodeSessionId: 'ses_f7298f269ffeJgrIaMwEDED031',
  publishedAt: '2026-09-10T22:18:55.000Z',
};

describe('OpenCode native-state attempt pointer', () => {
  it('accepts exactly the published shape', () => {
    expect(isOpenCodeNativeStateAttempt(valid)).toBe(true);
  });

  it.each([
    ['wrong version', { ...valid, version: 2 }],
    ['non-uuid task', { ...valid, attemptTaskId: '../escape' }],
    ['bad digest', { ...valid, digest: 'md5:abc' }],
    ['zero bytes', { ...valid, bytes: 0 }],
    ['empty session', { ...valid, openCodeSessionId: '' }],
    ['bad timestamp', { ...valid, publishedAt: 'yesterday' }],
    ['extra field', { ...valid, path: '/etc/passwd' }],
    ['array', [valid]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isOpenCodeNativeStateAttempt(value)).toBe(false);
  });
});
