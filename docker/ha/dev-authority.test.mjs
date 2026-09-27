import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDevAuthority } from './dev-authority.mjs';

test('signed tenant authority requires exact acknowledgment and survives failure/restart without re-enabling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agor-dev-authority-'));
  try {
    let failure = false;
    let mismatch = false;
    const observed = [];
    const options = {
      directory: join(root, 'private'),
      publicDirectory: join(root, 'public'),
      issuer: 'http://dev-launcher:4000',
      endpoint: 'http://daemon-a:3030/auth/external-authority',
      fetcher: async (url, request) => {
        assert.equal(url, options.endpoint);
        const { assertion } = JSON.parse(request.body);
        const [header, body, signature] = assertion.split('.');
        assert(
          verify(
            'RSA-SHA256',
            Buffer.from(`${header}.${body}`),
            readFileSync(join(root, 'public/public.pem')),
            Buffer.from(signature, 'base64url')
          )
        );
        const claims = JSON.parse(Buffer.from(body, 'base64url'));
        assert.equal(claims.aud, 'agor-authority:ha-dev');
        assert.equal(claims.tenant_id, 'acme');
        assert.equal(claims.sub, 'aaron-member');
        assert.equal(claims.exp - claims.iat, 60);
        observed.push(claims);
        if (failure) throw new Error('synthetic unavailable');
        return Response.json({
          protocol: 1,
          outcome: 'applied',
          applied_revision: mismatch ? '999' : claims.revision,
          applied_login_epoch: claims.login_epoch,
        });
      },
    };
    const persona = { id: 'acme-aaron', tenantId: 'acme', subject: 'aaron-member', role: 'member' };
    let authority = createDevAuthority(options);
    assert.deepEqual(await authority.synchronize(persona), {
      revision: '1',
      login_epoch: '1',
      active: true,
    });
    failure = true;
    await assert.rejects(authority.synchronize(persona, 'disable'));
    authority = createDevAuthority(options);
    failure = false;
    assert.deepEqual(await authority.synchronize(persona), {
      revision: '2',
      login_epoch: '2',
      active: false,
    });
    mismatch = true;
    await assert.rejects(authority.synchronize(persona), /acknowledgment/);
    mismatch = false;
    assert.deepEqual(await authority.synchronize(persona, 'enable'), {
      revision: '3',
      login_epoch: '3',
      active: true,
    });
    const results = await Promise.all([
      authority.synchronize(persona, 'revoke'),
      authority.synchronize(persona, 'disable'),
    ]);
    assert.deepEqual(
      results.map((x) => x.revision),
      ['4', '5']
    );
    assert.equal(observed.at(-1).active, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
