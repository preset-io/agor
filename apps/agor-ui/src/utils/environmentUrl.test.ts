import type { Branch } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import {
  getEnvironmentAccessUrl,
  getEnvironmentAccessUrls,
  hasEnvironmentHealthTarget,
} from './environmentUrl';

const base = { branch_id: 'branch-id', repo_id: 'repo-id', name: 'branch' } as Branch;

describe('getEnvironmentAccessUrls', () => {
  it('preserves ordered named runtime URLs', () => {
    const branch = {
      ...base,
      app_url: 'https://static.example.test',
      environment_instance: {
        status: 'running',
        access_urls: [
          { name: 'App', url: 'https://app.example.test' },
          { name: 'Metrics', url: 'https://metrics.example.test' },
        ],
      },
    } as Branch;
    expect(getEnvironmentAccessUrls(branch)).toEqual([
      { name: 'App', url: 'https://app.example.test' },
      { name: 'Metrics', url: 'https://metrics.example.test' },
    ]);
    expect(getEnvironmentAccessUrl(branch)).toBe('https://app.example.test');
  });

  it('drops unsafe/duplicate runtime URLs and falls back to the static URL only when empty', () => {
    expect(
      getEnvironmentAccessUrls({
        ...base,
        app_url: 'https://static.example.test/path?tab=1',
        environment_instance: {
          status: 'running',
          access_urls: [
            { name: 'App', url: 'javascript:alert(1)' },
            { name: 'app', url: 'https://duplicate.example.test' },
          ],
        },
      } as Branch)
    ).toEqual([{ name: 'app', url: 'https://duplicate.example.test' }]);

    expect(
      getEnvironmentAccessUrls({
        ...base,
        app_url: 'https://static.example.test/path?tab=1',
        environment_instance: {
          status: 'running',
          access_urls: [{ name: 'App', url: 'javascript:alert(1)' }],
        },
      } as Branch)
    ).toEqual([{ name: 'App', url: 'https://static.example.test/path?tab=1' }]);
  });
});

describe('hasEnvironmentHealthTarget', () => {
  it('recognizes static, typed runtime, and transitional runtime health targets', () => {
    expect(
      hasEnvironmentHealthTarget({ ...base, health_check_url: 'http://localhost:3030/health' })
    ).toBe(true);
    expect(
      hasEnvironmentHealthTarget({
        ...base,
        environment_instance: {
          status: 'running',
          lifecycle_result: {
            version: 1,
            health_url: 'https://runtime.example.test/health',
          },
        },
      } as Branch)
    ).toBe(true);
    expect(
      hasEnvironmentHealthTarget({
        ...base,
        environment_instance: {
          status: 'running',
          facts: { health: 'https://legacy.example.test/health' },
        },
      } as Branch)
    ).toBe(true);
  });

  it('rejects missing and unsafe health targets without falling through typed output', () => {
    expect(hasEnvironmentHealthTarget(base)).toBe(false);
    expect(
      hasEnvironmentHealthTarget({
        ...base,
        environment_instance: {
          status: 'running',
          lifecycle_result: { version: 1, health_url: 'http://127.0.0.1:3000/health' },
          facts: { health: 'https://legacy.example.com/health' },
        },
      } as Branch)
    ).toBe(false);
    expect(
      hasEnvironmentHealthTarget({
        ...base,
        environment_instance: {
          status: 'running',
          lifecycle_result: {
            version: 1,
            health_url: 'https://example.com/health?token=secret',
          },
        },
      } as Branch)
    ).toBe(false);
    expect(
      hasEnvironmentHealthTarget({
        ...base,
        environment_instance: {
          status: 'running',
          facts: { health: 'http://127.0.0.1:3000/health' },
        },
      } as Branch)
    ).toBe(false);
  });
});
