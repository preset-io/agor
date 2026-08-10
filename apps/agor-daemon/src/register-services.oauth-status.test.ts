import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('register-services durable OAuth status authority', () => {
  const source = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
  const start = source.indexOf("app.use('/mcp-servers/oauth-status'");
  const end = source.indexOf("app.use('/mcp-servers/oauth-attempt-status'", start);
  const statusBlock = start < 0 || end < 0 ? '' : source.slice(start, end);

  it('never advertises a refresh-ambiguous grant as authenticated', () => {
    expect(statusBlock).toContain("token.refresh_status === 'ambiguous'");
    expect(statusBlock.indexOf("token.refresh_status === 'ambiguous'")).toBeLessThan(
      statusBlock.indexOf('authenticatedServerIds.add')
    );
  });

  it('revalidates PostgreSQL grant configuration before advertising it', () => {
    expect(statusBlock).toContain('isMCPOAuthGrantBoundToServer');
  });
});
