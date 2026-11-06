import { describe, expect, it, vi } from 'vitest';
import { apiKeyProblem, apiKeysProblem, isAgorCloudHost, redactSecrets } from './options';

vi.mock('@agor/core/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/config')>()),
  loadConfig: vi.fn(async () => ({})),
}));

describe('isAgorCloudHost', () => {
  it('matches the Agor Cloud workspace hosts and nothing else', async () => {
    expect(await isAgorCloudHost('acme.dp-us1a.agor.cloud')).toBe(true);
    expect(await isAgorCloudHost('ACME.cloud.agor.live')).toBe(true);
    expect(await isAgorCloudHost('agor.example.com')).toBe(false);
    expect(await isAgorCloudHost('evilagor.cloud')).toBe(false);
    expect(await isAgorCloudHost('agor.cloud.example.com')).toBe(false);
  });
});

describe('API keys in errors', () => {
  it('refuses a key Node would reject as a header, without echoing it', () => {
    expect(apiKeyProblem('agor_sk_abc123')).toBeNull();
    for (const bad of ['agor_sk_abc\n123', 'agor_sk_abc 123', 'agor_sk_ąbc', 'agor_sk_\u0000']) {
      const problem = apiKeyProblem(bad);
      expect(problem).toBeTruthy();
      expect(problem).not.toContain('agor_sk');
    }
  });

  it('names a malformed source key before the target key, without echoing either', () => {
    const source = 'agor_sk_source\nsecret';
    const problem = apiKeysProblem([
      { key: source, label: 'The API key for this Agor (AGOR_API_KEY or your sign-in)' },
      { key: 'agor_sk_target\nsecret', label: 'The API key in TARGET_KEY' },
    ]);
    expect(problem).toMatch(/^The API key for this Agor \(AGOR_API_KEY or your sign-in\) /);
    expect(problem).not.toContain('agor_sk');
    expect(apiKeysProblem([{ key: 'agor_sk_ok', label: 'x' }])).toBeNull();
  });

  it('redacts both keys from a surfaced error', () => {
    const source = 'agor_sk_source';
    const target = 'agor_sk_target';
    const error = `Headers.set: "Bearer ${source}" is invalid; also "Bearer ${target}"`;
    expect(redactSecrets(error, [target, source])).toBe(
      'Headers.set: "Bearer [redacted]" is invalid; also "Bearer [redacted]"'
    );
    expect(redactSecrets('no key here', ['', undefined])).toBe('no key here');
  });
});
