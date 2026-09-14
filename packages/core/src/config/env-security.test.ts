import { describe, expect, it } from 'vitest';
import { filterEnv } from './env-blocklist';
import { isValid, validateEnvVar } from './env-validation';

describe('managed environment structural safety', () => {
  it('rejects shell syntax in names without interpreting values', () => {
    for (const name of ['`touch /tmp/pwned`', '$(rm -rf /)', 'A;B', 'A B', '123_NAME']) {
      expect(validateEnvVar(name, 'value').some((error) => error.code === 'invalid_format')).toBe(
        true
      );
    }
    expect(isValid(validateEnvVar('COMMAND', '$(this remains an inert env value)'))).toBe(true);
  });

  it('enforces the 10 KiB UTF-8 limit at persistence and runtime', () => {
    const tooLarge = '🔒'.repeat(3000);
    expect(validateEnvVar('VALUE', tooLarge).some((error) => error.code === 'too_long')).toBe(true);
    expect(filterEnv({ VALUE: tooLarge })).toEqual({ env: {}, rejected: ['VALUE'] });

    const valid = '🔒'.repeat(2000);
    expect(isValid(validateEnvVar('VALUE', valid))).toBe(true);
    expect(filterEnv({ VALUE: valid }).env.VALUE).toBe(valid);
  });

  it('rejects empty persistence values and NULs at both boundaries', () => {
    expect(validateEnvVar('VALUE', '').some((error) => error.code === 'empty_value')).toBe(true);
    expect(
      validateEnvVar('VALUE', 'x\0y').some((error) => error.code === 'invalid_character')
    ).toBe(true);
    expect(filterEnv({ VALUE: 'x\0y' })).toEqual({ env: {}, rejected: ['VALUE'] });
  });

  it('allows explicitly configured process controls for the same user executor', () => {
    for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'OPENAI_API_KEY']) {
      expect(isValid(validateEnvVar(name, 'configured-by-user'))).toBe(true);
    }
  });
});
