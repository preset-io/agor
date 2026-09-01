import type { Branch } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getEnvironmentAccessUrl, getEnvironmentHealthUrl } from './environmentUrl';

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

describe('getEnvironmentHealthUrl', () => {
  it('prefers a safe runtime health URL over the static URL', () => {
    expect(
      getEnvironmentHealthUrl({
        ...base,
        health_check_url: 'https://static.example.test/health',
        environment_instance: {
          status: 'running',
          health_url: 'https://dynamic.example.test/ready',
        },
      })
    ).toBe('https://dynamic.example.test/ready');
  });

  it('rejects unsafe runtime health URLs and falls back to static configuration', () => {
    expect(
      getEnvironmentHealthUrl({
        ...base,
        health_check_url: 'http://localhost:3000/health',
        environment_instance: {
          status: 'running',
          health_url: 'javascript:alert(1)',
        },
      })
    ).toBe('http://localhost:3000/health');
  });
});
