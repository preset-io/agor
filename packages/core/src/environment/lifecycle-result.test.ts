import { describe, expect, it } from 'vitest';
import {
  isAllowedDynamicEnvironmentHealthUrl,
  validateEnvironmentLifecycleResult,
} from './lifecycle-result';

describe('validateEnvironmentLifecycleResult', () => {
  it('accepts the tiny optional app/health schema', () => {
    expect(validateEnvironmentLifecycleResult({})).toEqual({});
    expect(
      validateEnvironmentLifecycleResult({
        app: 'https://space-5000.app.github.dev',
        health: 'https://space-3000.app.github.dev/health',
      })
    ).toEqual({
      app: 'https://space-5000.app.github.dev/',
      health: 'https://space-3000.app.github.dev/health',
    });
  });

  it.each([
    null,
    [],
    { app: '' },
    { health: null },
    { app: 'file:///tmp/app' },
    { app: 'https://user:secret@example.test' },
    { health: 'https://example.test/health?token=secret' },
    { app: 'https://example.test', token: 'secret' },
  ])('rejects an invalid or over-broad result: %o', (value) => {
    expect(() => validateEnvironmentLifecycleResult(value)).toThrow();
  });
});

describe('isAllowedDynamicEnvironmentHealthUrl', () => {
  it('allows public HTTP(S) destinations and rejects private or secret-bearing ones', () => {
    expect(isAllowedDynamicEnvironmentHealthUrl('https://space-3000.app.github.dev/health')).toBe(
      true
    );
    expect(isAllowedDynamicEnvironmentHealthUrl('http://127.0.0.1:3000/health')).toBe(false);
    expect(isAllowedDynamicEnvironmentHealthUrl('http://169.254.169.254/latest')).toBe(false);
    expect(isAllowedDynamicEnvironmentHealthUrl('https://example.test/health?token=x')).toBe(false);
  });
});
