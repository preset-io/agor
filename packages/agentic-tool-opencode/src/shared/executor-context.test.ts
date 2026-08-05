import { describe, expect, it } from 'vitest';
import { createOpenCodeExecutorContext, parseOpenCodeExecutorContext } from './executor-context.js';

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
});
