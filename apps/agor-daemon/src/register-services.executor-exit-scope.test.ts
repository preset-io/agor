import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('executor exit termination tenant scope', () => {
  it('gives launcher-exit durable operations fresh tenant database units', () => {
    const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
    const executor = source.slice(
      source.indexOf('const withTerminationTenantDatabase'),
      source.indexOf('if (openCodeLaunch)', source.indexOf('const withTerminationTenantDatabase'))
    );

    expect(executor).toContain('withTenantDatabase: withTerminationTenantDatabase');
    expect(executor).toMatch(
      /withTerminationTenantDatabase\(\(\) =>\s+\(\s+app\.service\('tasks'\)/
    );
  });
});
