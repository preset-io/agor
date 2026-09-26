import type { Branch } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getEnvironmentHealthUrl } from './environmentHealthUrl';

const base = { branch_id: 'branch-id', repo_id: 'repo-id', name: 'branch' } as Branch;

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
