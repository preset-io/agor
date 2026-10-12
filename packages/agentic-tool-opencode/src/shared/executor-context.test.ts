import { describe, expect, it } from 'vitest';
import {
  createOpenCodeExecutorContext,
  createOpenCodeManagedExecutorContext,
  parseOpenCodeExecutorContext,
} from './executor-context.js';

describe('OpenCode executor context', () => {
  it('round-trips the daemon-authorized native data home', () => {
    expect(
      parseOpenCodeExecutorContext(createOpenCodeExecutorContext('/opaque/native-home'))
    ).toEqual({
      dataHome: '/opaque/native-home',
    });
  });

  it('round-trips hosted identity and refuses any extra or malformed field', () => {
    const session = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50';
    const task = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51';
    const context = createOpenCodeManagedExecutorContext(session, task);
    expect(parseOpenCodeExecutorContext(context)).toEqual({
      mode: 'managed',
      sessionId: session,
      taskId: task,
    });
    for (const value of [
      { ...context, dataHome: '/home' },
      { ...context, taskId: '../x' },
      { mode: 'other', sessionId: session, taskId: task },
    ]) {
      expect(() => parseOpenCodeExecutorContext(value)).toThrow(/managed executor context/);
    }
  });

  it('fails closed when the generic host context is absent or malformed', () => {
    for (const value of [undefined, null, {}, { dataHome: '' }, { dataHome: 1 }]) {
      expect(() => parseOpenCodeExecutorContext(value)).toThrow(/executor context|data home/i);
    }
  });
});
