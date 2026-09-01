import type { Branch } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getEnvironmentAccessUrl, getEnvironmentAccessUrls } from './environmentUrl';

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
