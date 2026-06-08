import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('register-hooks MCP custom header redaction', () => {
  const source = readFileSync(new URL('./register-hooks.ts', import.meta.url), 'utf8');

  it('redacts MCP custom header values in mcp-servers responses', () => {
    expect(source).toContain('redactMCPHeaderSecrets');
    expect(source).toContain(
      "headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, '••••••••']))"
    );
    expect(source).toMatch(/find:\s*\[injectPerUserOAuthTokens,\s*redactMCPHeaderSecrets\]/);
    expect(source).toMatch(/get:\s*\[injectPerUserOAuthTokens,\s*redactMCPHeaderSecrets\]/);
  });

  it('keeps raw headers available to executor session-token calls', () => {
    expect(source).toContain("auth?.strategy === 'session-token'");
  });
});
