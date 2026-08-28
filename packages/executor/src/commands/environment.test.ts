import { describe, expect, it } from 'vitest';
import {
  parseEnvironmentCommandOutput,
  startCompletionWithoutContinuousHealth,
} from './environment.js';

describe('parseEnvironmentCommandOutput', () => {
  it('extracts dynamic access URLs and removes the protocol line from persisted output', () => {
    const parsed = parseEnvironmentCommandOutput(
      [
        'Codespace is ready',
        'AGOR_ENVIRONMENT_RESULT={"access_urls":[{"name":"App","url":"https://space-5000.app.github.dev"},{"name":"Codespace","url":"https://space.github.dev"}]}',
        '',
      ].join('\n')
    );

    expect(parsed.output).toBe('Codespace is ready\n');
    expect(parsed.environmentResult).toEqual({
      access_urls: [
        { name: 'App', url: 'https://space-5000.app.github.dev/' },
        { name: 'Codespace', url: 'https://space.github.dev/' },
      ],
    });
  });

  it('leaves ordinary lifecycle output unchanged', () => {
    expect(parseEnvironmentCommandOutput('docker compose started\n')).toEqual({
      output: 'docker compose started\n',
    });
  });

  it.each([
    'AGOR_ENVIRONMENT_RESULT=not-json',
    'AGOR_ENVIRONMENT_RESULT={"access_urls":[]}',
    'AGOR_ENVIRONMENT_RESULT={"access_urls":[{"name":"App","url":"file:///tmp/app"}]}',
    'AGOR_ENVIRONMENT_RESULT={"access_urls":[{"name":"App","url":"https://user:secret@example.test"}]}',
    'AGOR_ENVIRONMENT_RESULT={"access_urls":[{"name":"App","url":"https://example.test?token=secret"}]}',
    'AGOR_ENVIRONMENT_RESULT={"access_urls":[{"name":"App","url":"https://example.test"}],"token":"secret"}',
  ])('rejects an invalid or over-broad result: %s', (output) => {
    expect(() => parseEnvironmentCommandOutput(output)).toThrow();
  });

  it('rejects ambiguous duplicate result lines', () => {
    const line =
      'AGOR_ENVIRONMENT_RESULT={"access_urls":[{"name":"App","url":"https://example.test"}]}';
    expect(() => parseEnvironmentCommandOutput(`${line}\n${line}`)).toThrow(
      'more than one result line'
    );
  });
});

describe('startCompletionWithoutContinuousHealth', () => {
  it('marks a completed no-health command running without claiming a successful probe', () => {
    expect(startCompletionWithoutContinuousHealth(undefined, '2026-08-28T00:00:00Z')).toEqual({
      status: 'running',
      last_health_check: {
        timestamp: '2026-08-28T00:00:00Z',
        status: 'unknown',
        message: 'Start command completed; no continuous health URL is configured',
      },
    });
  });

  it('leaves a static-health environment starting for the health monitor', () => {
    expect(
      startCompletionWithoutContinuousHealth('https://example.test/health', '2026-08-28T00:00:00Z')
    ).toEqual({});
  });
});
