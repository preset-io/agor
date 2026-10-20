import { afterEach, describe, expect, it } from 'vitest';
import { buildAllowlistedEnv } from './env-resolver';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('ALLOWED_ENV_VARS', () => {
  it('keeps the log format controls', () => {
    process.env.AGOR_LOG_FORMAT = 'json';
    process.env.NODE_NO_WARNINGS = '1';
    expect(buildAllowlistedEnv()).toMatchObject({
      AGOR_LOG_FORMAT: 'json',
      NODE_NO_WARNINGS: '1',
    });
  });
});
