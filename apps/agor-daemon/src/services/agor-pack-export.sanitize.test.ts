import { describe, expect, it } from 'vitest';
import { sanitizeMcpArgs, sanitizeMcpUrl } from './agor-pack-export';

describe('MCP credential sanitizing for .agor', () => {
  it('drops userinfo and credential-named query values, keeping env references', () => {
    expect(
      sanitizeMcpUrl('https://user:pw@example.test/mcp?api_key=plain&region=eu&design=x')
    ).toEqual({
      url: 'https://example.test/mcp?api_key=[redacted]&region=eu&design=x',
      changed: true,
    });
    expect(sanitizeMcpUrl('https://example.test/mcp?token={{ user.env.TOKEN }}')).toEqual({
      url: 'https://example.test/mcp?token={{ user.env.TOKEN }}',
      changed: false,
    });
    expect(sanitizeMcpUrl('https://example.test/mcp?author=me').changed).toBe(false);
  });

  it('drops credential flag values in both argument forms', () => {
    expect(
      sanitizeMcpArgs(['--api-key', 'plain', '--token=abc', '--port', '8080', '-y', 'pkg'])
    ).toEqual({
      args: ['--api-key', '[redacted]', '--token=[redacted]', '--port', '8080', '-y', 'pkg'],
      changed: true,
    });
    expect(sanitizeMcpArgs(['--api-key', '{{ user.env.KEY }}']).changed).toBe(false);
  });
});
