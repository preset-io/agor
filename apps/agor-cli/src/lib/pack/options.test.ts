import { describe, expect, it, vi } from 'vitest';
import { apiKeyProblem, isAgorCloudHost, redactSecret } from './options';

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

  it('redacts the key from a surfaced error', () => {
    const key = 'agor_sk_secret';
    const error = `Headers.append: "Bearer ${key}" is an invalid header value; again ${key}`;
    expect(redactSecret(error, key)).toBe(
      'Headers.append: "Bearer [redacted]" is an invalid header value; again [redacted]'
    );
    expect(redactSecret('no key here', '')).toBe('no key here');
  });
});
