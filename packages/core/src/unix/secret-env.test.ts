import { describe, expect, it } from 'vitest';
import {
  isSecretEnvKey,
  redactSecretEnv,
  SECRET_ENV_KEY_PATTERN,
  splitSecretEnv,
} from './secret-env.js';

describe('isSecretEnvKey / SECRET_ENV_KEY_PATTERN', () => {
  it('matches *_API_KEY', () => {
    expect(isSecretEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretEnvKey('OPENAI_API_KEY')).toBe(true);
    expect(isSecretEnvKey('GEMINI_API_KEY')).toBe(true);
    expect(isSecretEnvKey('GOOGLE_API_KEY')).toBe(true);
  });

  it('matches *_TOKEN', () => {
    expect(isSecretEnvKey('GITHUB_TOKEN')).toBe(true);
    expect(isSecretEnvKey('ANTHROPIC_AUTH_TOKEN')).toBe(true);
  });

  it('matches *_SECRET', () => {
    expect(isSecretEnvKey('JWT_SECRET')).toBe(true);
    expect(isSecretEnvKey('CLIENT_SECRET')).toBe(true);
  });

  it('matches OAUTH_* prefix', () => {
    expect(isSecretEnvKey('OAUTH_ACCESS_TOKEN')).toBe(true);
    expect(isSecretEnvKey('OAUTH_REFRESH_TOKEN')).toBe(true);
  });

  it('does not match non-secret names', () => {
    expect(isSecretEnvKey('PATH')).toBe(false);
    expect(isSecretEnvKey('HOME')).toBe(false);
    expect(isSecretEnvKey('NODE_ENV')).toBe(false);
    expect(isSecretEnvKey('DAEMON_URL')).toBe(false);
    expect(isSecretEnvKey('TERM')).toBe(false);
  });

  it('pattern is exported for caller use', () => {
    expect(SECRET_ENV_KEY_PATTERN).toBeInstanceOf(RegExp);
  });
});

describe('redactSecretEnv', () => {
  it('drops secret keys by default', () => {
    const input = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      GITHUB_TOKEN: 'ghp-leak',
    };
    const out = redactSecretEnv(input);
    expect(out).toEqual({ PATH: '/usr/bin' });
    // Values never appear
    expect(JSON.stringify(out)).not.toContain('sk-ant-leak');
    expect(JSON.stringify(out)).not.toContain('ghp-leak');
  });

  it('with keepKeys=true, redacts values but keeps keys', () => {
    const out = redactSecretEnv(
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-leak' },
      { keepKeys: true }
    );
    expect(out).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: '***' });
    expect(JSON.stringify(out)).not.toContain('sk-ant-leak');
  });

  it('drops undefined values', () => {
    const out = redactSecretEnv({ PATH: '/usr/bin', MAYBE: undefined });
    expect(out).toEqual({ PATH: '/usr/bin' });
  });
});

describe('splitSecretEnv', () => {
  it('partitions secret vs inline env entries', () => {
    const { secret, inline } = splitSecretEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-leak',
      DAEMON_URL: 'http://x',
      OAUTH_TOKEN: 'oauth-leak',
    });
    expect(inline).toEqual({ PATH: '/usr/bin', DAEMON_URL: 'http://x' });
    expect(secret).toEqual({ ANTHROPIC_API_KEY: 'sk-leak', OAUTH_TOKEN: 'oauth-leak' });
  });

  it('drops undefined values', () => {
    const { secret, inline } = splitSecretEnv({
      PATH: '/usr/bin',
      MISSING: undefined,
      ANTHROPIC_API_KEY: undefined,
    });
    expect(inline).toEqual({ PATH: '/usr/bin' });
    expect(secret).toEqual({});
  });

  it('returns empty objects for empty input', () => {
    const { secret, inline } = splitSecretEnv({});
    expect(secret).toEqual({});
    expect(inline).toEqual({});
  });
});
