// Run after building core: node --test scripts/check-mcp-oauth-build.test.mjs
// Source aliases cannot detect duplicated state in independently bundled exports.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

for (const format of ['js', 'cjs']) {
  test(`OAuth refresh shares the daemon DB authority (${format})`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), 'agor-oauth-build-test-'));
    const overrides = {
      HOME: home,
      USERPROFILE: home,
      AGOR_DATA_HOME: home,
      AGOR_MASTER_SECRET: 'fictional-packaged-test-key',
    };
    const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    t.after(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    });
    const load = (path) =>
      format === 'cjs' ? require(path) : import(new URL(path, import.meta.url));
    const dbModule = await load(`../packages/core/dist/db/index.${format}`);
    const oauth = await load(`../packages/core/dist/tools/mcp/oauth-refresh.${format}`);
    const entitlement = await load(`../packages/core/dist/tools/mcp/grant-entitlement.${format}`);
    t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Network is forbidden in this test');
    });
    // Only scope mechanics are real. No database or provider is contacted.
    const raw = { execute: async () => [], transaction: async (work) => work(raw) };
    const db = dbModule.createTenantScopedDatabaseProxy(raw);
    const token = {
      user_id: 'caller-a',
      mcp_server_id: 'server-a',
      oauth_access_token: 'fictional-peer-refreshed-access',
      oauth_refresh_token: 'fictional-daemon-only-refresh',
      grant_generation: 1,
      grant_binding_fingerprint: 'fictional-binding',
      refresh_generation: 2,
      refresh_success_generation: 2,
      refresh_status: 'idle',
    };
    const claim = t.mock.method(
      dbModule.UserMCPOAuthTokenRepository.prototype,
      'claimRefresh',
      async (userId, serverId) => {
        assert.equal(dbModule.getCurrentTenantId(), 'tenant-a');
        return {
          outcome: 'observed',
          token: userId === 'caller-a' && serverId === 'server-a' ? token : null,
        };
      }
    );
    const input = {
      db,
      tenantId: 'tenant-a',
      userId: 'caller-a',
      mcpServerId: 'server-a',
      observedRefreshVersion: {
        grantGeneration: 1,
        grantBindingFingerprint: 'fictional-binding',
        refreshGeneration: 1,
      },
      validateGrant: async () => {
        assert.equal(dbModule.getCurrentTenantId(), 'tenant-a');
        return true;
      },
    };
    assert.equal(await oauth.refreshAndPersistToken(input), token.oauth_access_token);
    assert.equal(claim.mock.callCount(), 1);
    // Refresh persistence also rechecks subject standing inside the existing
    // tenant unit. Its separately built helper must share that unit too.
    const subject = t.mock.method(dbModule.UsersRepository.prototype, 'findById', async (id) => {
      assert.equal(dbModule.getCurrentTenantId(), 'tenant-a');
      return id === 'caller-a' ? { user_id: id, role: 'member' } : null;
    });
    await dbModule.runWithTenantDatabaseScope(db, 'tenant-a', async (scoped) => {
      const check = {
        db: scoped,
        tenantId: 'tenant-a',
        subjectUserId: 'caller-a',
        oauthMode: 'per_user',
      };
      await entitlement.assertMcpGrantSubjectEntitled(check);
      await assert.rejects(
        entitlement.assertMcpGrantSubjectEntitled({ ...check, subjectUserId: 'caller-b' }),
        entitlement.MCPGrantSubjectNotEntitledError
      );
    });
    assert.equal(subject.mock.callCount(), 2);
    await assert.rejects(
      dbModule.runWithTenantContext('tenant-b', () => oauth.refreshAndPersistToken(input)),
      /tenant/i
    );
    assert.equal(claim.mock.callCount(), 1, 'conflicting tenant must not reach the repository');
    await assert.rejects(
      oauth.refreshAndPersistToken({ ...input, userId: 'caller-b' }),
      oauth.InvalidGrantError
    );
    assert.throws(() => 'run' in db, /Missing tenant database scope/, 'do not disarm the proxy');
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
}
