import { describe, expect, it } from 'vitest';
import { redactCommandForAudit } from './environment-command-spawn.js';

describe('redactCommandForAudit', () => {
  it('redacts inline TOKEN= assignments', () => {
    expect(redactCommandForAudit('GITHUB_TOKEN=ghp_abc123 docker compose up')).toBe(
      'GITHUB_TOKEN=*** docker compose up'
    );
  });

  it('redacts SECRET / PASSWORD / API_KEY suffixes', () => {
    expect(redactCommandForAudit('APP_SECRET=s3cret DB_PASSWORD=hunter2 run')).toBe(
      'APP_SECRET=*** DB_PASSWORD=*** run'
    );
    expect(redactCommandForAudit('STRIPE_API_KEY=sk_live_xxx node index.js')).toBe(
      'STRIPE_API_KEY=*** node index.js'
    );
  });

  it('is case-insensitive on the key name', () => {
    expect(redactCommandForAudit('my_token=abc run')).toBe('my_token=*** run');
  });

  it('leaves non-secret env vars alone', () => {
    expect(redactCommandForAudit('NODE_ENV=production PORT=3000 node .')).toBe(
      'NODE_ENV=production PORT=3000 node .'
    );
  });

  it('redacts at start of string without eating a leading char', () => {
    expect(redactCommandForAudit('TOKEN=abc docker')).toBe('TOKEN=*** docker');
  });

  it('truncates commands longer than the audit limit', () => {
    const long = `docker run ${'x'.repeat(2000)}`;
    const out = redactCommandForAudit(long);
    expect(out.length).toBeLessThanOrEqual(1024 + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('preserves semicolon/pipe separators before key', () => {
    expect(redactCommandForAudit('echo ok; FOO_TOKEN=abc docker')).toBe(
      'echo ok; FOO_TOKEN=*** docker'
    );
  });
});
