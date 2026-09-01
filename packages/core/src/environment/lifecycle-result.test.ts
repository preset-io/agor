import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_LIFECYCLE_RESULT_MAX_ACCESS_URLS,
  isAllowedDynamicEnvironmentHealthUrl,
  lifecycleResultTemplateFacts,
  validateEnvironmentLifecycleResult,
} from './lifecycle-result';

describe('validateEnvironmentLifecycleResult', () => {
  it('normalizes multiple named URLs, health, and opaque resource identity', () => {
    expect(
      validateEnvironmentLifecycleResult({
        version: 1,
        access_urls: [
          { name: 'App', url: 'https://app.example.test' },
          { name: 'Metrics', url: 'https://metrics.example.test/' },
        ],
        health_url: 'https://app.example.test/health',
        resource: {
          provider: 'github-codespaces',
          id: 'cs_123',
          name: 'space-name',
          manage_url: 'https://github.com/codespaces/space-name',
        },
      })
    ).toEqual({
      version: 1,
      access_urls: [
        { name: 'App', url: 'https://app.example.test/' },
        { name: 'Metrics', url: 'https://metrics.example.test/' },
      ],
      health_url: 'https://app.example.test/health',
      resource: {
        provider: 'github-codespaces',
        id: 'cs_123',
        name: 'space-name',
        manage_url: 'https://github.com/codespaces/space-name',
      },
    });
  });

  it('accepts only a full canonical revision acknowledgement', () => {
    const revision = 'a'.repeat(40);
    expect(validateEnvironmentLifecycleResult({ version: 1, applied_revision: revision })).toEqual({
      version: 1,
      applied_revision: revision,
    });

    for (const invalid of ['a'.repeat(12), 'A'.repeat(40), `${'a'.repeat(40)}-dirty`, 'unknown']) {
      expect(() =>
        validateEnvironmentLifecycleResult({ version: 1, applied_revision: invalid })
      ).toThrow('full lowercase Git');
    }
  });

  it.each([
    null,
    [],
    {},
    { version: 2 },
    { version: 1, token: 'secret' },
    { version: 1, access_urls: [] },
    { version: 1, access_urls: [{ name: 'App', url: 'file:///tmp/app' }] },
    {
      version: 1,
      access_urls: [
        { name: 'App', url: 'https://one.example.test' },
        { name: 'app', url: 'https://two.example.test' },
      ],
    },
    { version: 1, health_url: 'https://example.test/health?token=secret' },
    { version: 1, resource: {} },
    { version: 1, resource: { id: 'x', secret: 'nope' } },
  ])('rejects an invalid or over-broad result: %o', (value) => {
    expect(() => validateEnvironmentLifecycleResult(value)).toThrow();
  });

  it('bounds the number of URLs and total encoded size', () => {
    expect(() =>
      validateEnvironmentLifecycleResult({
        version: 1,
        access_urls: Array.from(
          { length: ENVIRONMENT_LIFECYCLE_RESULT_MAX_ACCESS_URLS + 1 },
          (_, index) => ({ name: `App ${index}`, url: `https://${index}.example.test` })
        ),
      })
    ).toThrow('too many');
    expect(() =>
      validateEnvironmentLifecycleResult({ version: 1, resource: { id: 'x'.repeat(9_000) } })
    ).toThrow('size limit');
  });
});

describe('lifecycleResultTemplateFacts', () => {
  it('exposes only the bounded compatibility fields', () => {
    expect(
      lifecycleResultTemplateFacts({
        version: 1,
        access_urls: [
          { name: 'App', url: 'https://app.example.test/' },
          { name: 'Metrics', url: 'https://metrics.example.test/' },
        ],
        health_url: 'https://app.example.test/health',
        resource: { provider: 'github-codespaces', id: '123', name: 'space' },
        applied_revision: 'b'.repeat(40),
      })
    ).toEqual({
      url: 'https://app.example.test/',
      health: 'https://app.example.test/health',
      name: 'space',
      resource_id: '123',
      resource_provider: 'github-codespaces',
      url_metrics: 'https://metrics.example.test/',
      applied_revision: 'b'.repeat(40),
    });
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
