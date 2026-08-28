import type { Branch } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getEnvironmentAccessUrl } from './environmentUrl';

const base = { branch_id: 'branch-id', repo_id: 'repo-id', name: 'branch' } as Branch;

describe('getEnvironmentAccessUrl', () => {
  it('prefers a dynamic App URL and falls back to the first dynamic URL', () => {
    expect(
      getEnvironmentAccessUrl({
        ...base,
        app_url: 'https://static.example.test',
        environment_instance: {
          status: 'running',
          access_urls: [
            { name: 'Codespace', url: 'https://editor.example.test' },
            { name: 'App', url: 'https://dynamic.example.test' },
          ],
        },
      })
    ).toBe('https://dynamic.example.test');

    expect(
      getEnvironmentAccessUrl({
        ...base,
        environment_instance: {
          status: 'running',
          access_urls: [{ name: 'Preview', url: 'https://preview.example.test' }],
        },
      })
    ).toBe('https://preview.example.test');
  });

  it('falls back to the static URL and rejects unsafe runtime URLs', () => {
    expect(
      getEnvironmentAccessUrl({
        ...base,
        app_url: 'https://static.example.test',
        environment_instance: {
          status: 'running',
          access_urls: [{ name: 'App', url: 'javascript:alert(1)' }],
        },
      })
    ).toBe('https://static.example.test');
  });
});
