import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vite daemon proxy', () => {
  it('forwards the browser OAuth callback path to the daemon', () => {
    const source = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(source).toMatch(/['"]\/mcp-servers\/oauth-callback['"]\s*:\s*\{/);
    expect(source).toMatch(/target:\s*`http:\/\/localhost:\$\{daemonPort\}`/);
  });
});
