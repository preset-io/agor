import { describe, expect, it } from 'vitest';
import { cloneDiagnostic } from './clone-diagnostic.js';

describe('cloneDiagnostic', () => {
  it('retains multiline failures and strips terminal formatting', () => {
    expect(cloneDiagnostic("Cloning into 'repo'...\n\u001b[31mfatal: not found\u001b[0m\n")).toBe(
      "Cloning into 'repo'...\nfatal: not found"
    );
  });

  it('redacts credentials on every line before bounding the diagnostic', () => {
    const token = 'github_pat_test_only_1234567890';
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    const message = cloneDiagnostic(
      `Cloning into 'repo'...\nremote: ${token} ${encoded}\n` +
        'fatal: https://user:password@example.com/repo.git?access_token=query-secret\n' +
        'proxy: http://proxy-user:proxy-secret@proxy.test:8080\n' +
        'Authorization: Basic header-secret\nProxy-Authorization: Bearer proxy-header-secret',
      { GITHUB_TOKEN: token }
    );
    for (const secret of [
      token,
      encoded,
      'password',
      'query-secret',
      'proxy-secret',
      'header-secret',
    ]) {
      expect(message).not.toContain(secret);
    }
    expect(message).toContain('fatal: https://<redacted>@example.com/repo.git?<redacted>');
  });

  it('bounds oversized progress output while retaining the final actionable error', () => {
    const token = 'ghp_test_token_12345678901234567890';
    const message = cloneDiagnostic(
      `${'Receiving objects: 1%\r'.repeat(500)}${token}\nfatal: connection refused`,
      { GH_TOKEN: token }
    );
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toMatch(/^\[earlier output truncated\]/);
    expect(message).toMatch(/<redacted>\nfatal: connection refused$/);
    expect(message).not.toContain(token);
  });

  it('redacts a token that crosses the truncation boundary without leaking its suffix', () => {
    const token = `sensitive-${'0123456789abcdef'.repeat(8)}`;
    const output = `${'progress\n'.repeat(1000)}${token}${'x'.repeat(3900)}`;
    // Truncating first would split the token, preventing exact-value redaction.
    expect(output.slice(-4000)).toContain(token.slice(-32));
    expect(output.slice(-4000)).not.toContain(token);

    const message = cloneDiagnostic(output, { GH_TOKEN: token });
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain('<redacted>');
    expect(message).not.toContain(token.slice(-32));
  });
});
