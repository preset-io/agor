import { describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_ENV_VARS,
  filterEnv,
  getEnvVarBlockReason,
  isEnvVarAllowed,
  MAX_ENV_VAR_VALUE_BYTES,
} from './env-blocklist';

describe('explicit user environment filtering', () => {
  it('does not semantically block user-configured process controls', () => {
    expect(BLOCKED_ENV_VARS.size).toBe(0);
    for (const name of [
      'PATH',
      'HOME',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'AGOR_MASTER_SECRET',
      'GIT_AUTHOR_NAME',
      'OPENAI_API_KEY',
    ]) {
      expect(isEnvVarAllowed(name)).toBe(true);
      expect(getEnvVarBlockReason(name)).toBeNull();
    }
  });

  it('rejects malformed names, NULs, and oversized legacy values', () => {
    const onReject = vi.fn();
    const result = filterEnv(
      {
        PATH: '/user/bin',
        NODE_OPTIONS: '--require ./configured-by-user.cjs',
        'BAD-NAME': 'no',
        NUL_VALUE: 'bad\0value',
        TOO_LARGE: 'x'.repeat(MAX_ENV_VAR_VALUE_BYTES + 1),
      },
      onReject
    );

    expect(result.env).toEqual({
      PATH: '/user/bin',
      NODE_OPTIONS: '--require ./configured-by-user.cjs',
    });
    expect(result.rejected.sort()).toEqual(['BAD-NAME', 'NUL_VALUE', 'TOO_LARGE']);
    expect(onReject).toHaveBeenCalledTimes(3);
  });

  it('skips undefined entries', () => {
    expect(filterEnv({ A: 'a', B: undefined })).toEqual({ env: { A: 'a' }, rejected: [] });
  });
});
