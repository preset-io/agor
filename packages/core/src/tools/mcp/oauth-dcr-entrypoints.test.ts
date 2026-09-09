import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const authority = '@agor/core/tools/mcp/oauth-dcr-error';

describe('DCR nominal authority across independently packaged entrypoints', () => {
  it('externalizes one diagnostic authority instead of duplicating its WeakMap', () => {
    const manifest = JSON.parse(read('../package.json'));
    expect(manifest.exports['./tools/mcp/oauth-dcr-error']).toEqual({
      source: './src/tools/mcp/oauth-dcr-error.ts',
      types: './dist/tools/mcp/oauth-dcr-error.d.ts',
      import: './dist/tools/mcp/oauth-dcr-error.js',
      require: './dist/tools/mcp/oauth-dcr-error.cjs',
    });
    const bundler = read('../tsup.config.ts');
    expect(bundler).toContain("'tools/mcp/oauth-dcr-error': 'src/tools/mcp/oauth-dcr-error.ts'");
    expect(bundler.slice(bundler.indexOf('  external: ['))).toContain(`'${authority}'`);
    for (const consumer of ['tools/mcp/external-error.ts', 'tools/mcp/oauth-mcp-transport.ts']) {
      expect(read(consumer)).toContain(`from '${authority}'`);
      expect(read(consumer)).not.toMatch(/from ['"]\.\/oauth-dcr-error/);
    }
  });

  // Source-only local checks do not build packages. CI/package validation can
  // exercise actual independent artifacts; never substitute source aliases.
  it.skipIf(!existsSync(new URL('../dist/tools/mcp/oauth-dcr-error.js', root)))(
    'recognizes DCR evidence across the real ESM and CJS exports',
    () => {
      const script = `
        import assert from 'node:assert/strict';
        import { createRequire } from 'node:module';
        const require = createRequire(process.cwd() + '/package.json');
        for (const load of [(name) => import(name), (name) => require(name)]) {
          const { OAuthDCRFailure } = await load('@agor/core/tools/mcp/oauth-mcp-transport');
          const { sanitizeMCPExternalError } = await load('@agor/core/mcp');
          const safe = sanitizeMCPExternalError(new OAuthDCRFailure('SENTINEL', {
            stage: 'dcr_registration', http_status: 503, reason: 'registration_rejected',
            registration_endpoint_source: 'metadata',
          }), { stage: 'oauth' });
          assert.equal(safe.category, 'provider_unavailable');
          assert.deepEqual(safe.diagnostic, {
            event: 'mcp_external_failure', stage: 'dcr_registration', type: 'OAuthDCRFailure',
            status: 503, reason: 'registration_rejected', registration_endpoint_source: 'metadata',
          });
          assert.equal(JSON.stringify(safe).includes('SENTINEL'), false);
        }
      `;
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: fileURLToPath(new URL('../', root)),
        env: { ...process.env, NODE_OPTIONS: '' },
        timeout: 30_000,
        stdio: 'pipe',
      });
    }
  );
});
