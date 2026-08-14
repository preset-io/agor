import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('custom repository route authorization', () => {
  const source = readFileSync(join(__dirname, 'register-routes.ts'), 'utf8');

  it.each([
    ["'/repos/local'", "'/repos/clone'", 'add local repositories'],
    ["'/repos/clone'", "'/repos/:id/branches'", 'clone repositories'],
  ])('requires admin+ on %s before entering the custom service method', (start, end, action) => {
    const startIndex = source.indexOf(start);
    const route = source.slice(startIndex, source.indexOf(end, startIndex));

    expect(startIndex).toBeGreaterThan(0);
    expect(route).toContain(`role: ROLES.ADMIN, action: '${action}'`);
    expect(route).not.toContain(`role: ROLES.MEMBER, action: '${action}'`);
  });
});
