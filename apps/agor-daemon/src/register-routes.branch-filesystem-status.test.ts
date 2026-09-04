import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');

describe('Branch filesystem status route registration', () => {
  it('uses the authenticated long-route boundary with a read-only method', () => {
    const path = source.indexOf("'/branches/:id/filesystem-status'");
    const start = source.lastIndexOf('registerLongAuthenticatedRoute(', path);
    const end = source.indexOf('// Archive/delete branch', start);
    const route = source.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(route).toContain("'/branches/:id/filesystem-status'");
    expect(route).toContain('createBranchFilesystemStatusService(branchRepository, db, app)');
    expect(route).toContain(
      "find: { role: ROLES.VIEWER, action: 'observe branch filesystem status' }"
    );
    expect(route).not.toMatch(/\b(create|update|patch|remove)\s*:/);
  });

  it('advertises the versioned observer capability once in the public feature payload', () => {
    expect(source.match(/branchFilesystemObservation:/g)).toHaveLength(1);
    expect(source).toContain(
      'branchFilesystemObservation: BRANCH_FILESYSTEM_OBSERVATION_CAPABILITY'
    );
    expect(source).toContain('branchStorage: resolveBranchStorageHealthConfig(config)');
  });
});
