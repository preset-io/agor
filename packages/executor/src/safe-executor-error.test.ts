import { describe, expect, it } from 'vitest';
import { formatExecutorFailure } from './safe-executor-error';

describe('formatExecutorFailure', () => {
  it('removes Drizzle query text, parameters, and secrets', () => {
    const secret = 'super-secret-tool-result';
    const error = Object.assign(
      new Error(`Failed query: update messages set data=$1 params: ${secret}`),
      { query: 'update messages set data=$1', params: [secret], cause: { code: '22P05' } }
    );
    const output = formatExecutorFailure(error);
    expect(output).toBe('Database operation failed (22P05)');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('update messages');
  });

  it('recognizes a transported Drizzle error from its message alone', () => {
    const secret = 'transported-secret';
    const output = formatExecutorFailure(
      new Error(`Failed query: update messages set data=$1\nparams: ${secret}`)
    );
    expect(output).toBe('Database operation failed');
    expect(output).not.toContain(secret);
  });

  it('preserves ordinary provider failures within a bounded length', () => {
    expect(formatExecutorFailure(new Error('Provider authentication failed'))).toBe(
      'Provider authentication failed'
    );
    expect(formatExecutorFailure(new Error('x'.repeat(2_000))).length).toBeLessThanOrEqual(1_024);
  });
});
