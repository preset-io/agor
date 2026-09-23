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

  it('round-trips only the logical hosted context; the DB grant supplies checkpoint authority', () => {
    const context = createOpenCodeManagedExecutorContext(managed);
    expect(parseOpenCodeExecutorContext(JSON.parse(JSON.stringify(context)))).toEqual(context);
    expect(isOpenCodeManagedExecutorContext(context)).toBe(true);
    expect(isOpenCodeManagedExecutorContext({ dataHome: '/x' })).toBe(false);
  });

  it('rejects v2 and malformed/extra-field v3 contexts rather than falling back', () => {
    for (const value of [
      { version: 2 },
      { ...managed, version: 2, mode: 'managed-projection', taskId: managed.taskId.toUpperCase() },
      { mode: 'managed-projection', namespaceKey: 'short' },
      { ...managed, version: 2, mode: 'managed-projection', taskId: 'nope' },
      { ...managed, version: 2, mode: 'managed-projection' },
      { ...managed, version: 3, mode: 'managed-projection', accepted: null },
      { ...managed, version: 3, mode: 'not-managed' },
    ]) {
      expect(() => parseOpenCodeExecutorContext(value)).toThrow(/managed executor context/i);
    }
    expect(() => createOpenCodeManagedExecutorContext({ ...managed, namespaceKey: '' })).toThrow(
      /namespace key/
    );
  });
});
