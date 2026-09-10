import { describe, expect, it } from 'vitest';
import {
  createOpenCodeExecutorContext,
  createOpenCodeManagedExecutorContext,
  isOpenCodeManagedExecutorContext,
  parseOpenCodeExecutorContext,
} from './executor-context.js';

const managed = {
  namespaceKey: 'e'.repeat(64),
  agorSessionId: '01a08d5f-775f-73f6-86a1-624b43050180',
  taskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
  accepted: null,
};

describe('OpenCode executor context', () => {
  it('round-trips the daemon-authorized native data home', () => {
    expect(
      parseOpenCodeExecutorContext(createOpenCodeExecutorContext('/opaque/native-home'))
    ).toEqual({
      dataHome: '/opaque/native-home',
    });
  });

  it('fails closed when the generic host context is absent or malformed', () => {
    for (const value of [undefined, null, {}, { dataHome: '' }, { dataHome: 1 }]) {
      expect(() => parseOpenCodeExecutorContext(value)).toThrow(/executor context|data home/i);
    }
  });

  it('round-trips the hosted managed-projection context with an accepted checkpoint', () => {
    const accepted = {
      version: 1 as const,
      attemptTaskId: '01a08d5f-7773-77fa-a7dc-2575cfe6727e',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: 4096,
      openCodeSessionId: 'ses_1',
      publishedAt: '2026-09-10T22:18:55.000Z',
    };
    const context = createOpenCodeManagedExecutorContext({ ...managed, accepted });
    expect(parseOpenCodeExecutorContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
    expect(isOpenCodeManagedExecutorContext(context)).toBe(true);
    expect(isOpenCodeManagedExecutorContext({ dataHome: '/x' })).toBe(false);
  });

  it('rejects a malformed or partial v2 context rather than falling back to legacy behavior', () => {
    for (const value of [
      { version: 2 },
      { mode: 'managed-projection', namespaceKey: 'short' },
      { ...managed, version: 2, mode: 'managed-projection', taskId: 'nope' },
      { ...managed, version: 2, mode: 'managed-projection', accepted: { digest: 'x' } },
      { ...managed, version: 3, mode: 'managed-projection' },
    ]) {
      expect(() => parseOpenCodeExecutorContext(value)).toThrow(/managed executor context/i);
    }
    expect(() => createOpenCodeManagedExecutorContext({ ...managed, namespaceKey: '' })).toThrow(
      /namespace key/
    );
  });
});
