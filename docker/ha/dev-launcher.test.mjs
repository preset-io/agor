import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  buildLaunchRedirect,
  createDevLauncher,
  decodeJwtPayload,
  HA_DEV_PERSONAS,
} from './dev-launcher.mjs';

const SHARED_SECRET = 'agor-ha-dev-launch-secret-00000000000000000000';
const ISSUER = 'http://dev-launcher:4000';
const AUDIENCE = 'agor-runtime:ha-dev';
const INSTANCE_ID = 'agor-ha-dev';

let baseUrl;
let launcher;

before(async () => {
  launcher = createDevLauncher({
    publicOrigin: 'http://127.0.0.1:3030',
    issuer: ISSUER,
    audience: AUDIENCE,
    instanceId: INSTANCE_ID,
    sharedSecret: SHARED_SECRET,
  });
  await new Promise((resolve) => launcher.server.listen(0, '127.0.0.1', resolve));
  const address = launcher.server.address();
  assert(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    launcher.server.close((error) => (error ? reject(error) : resolve()))
  );
});

async function selectPersona(
  persona = 'acme-alice',
  tenant = 'acme',
  returnTo = '/ui/',
  launcherBaseUrl = baseUrl
) {
  return fetch(`${launcherBaseUrl}/dev-auth/select`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ persona, tenant, return_to: returnTo }),
  });
}

function launchCodeFrom(response) {
  const location = response.headers.get('location');
  assert(location);
  const code = new URL(location).searchParams.get('launch_code');
  assert(code);
  return code;
}

async function exchange(launchCode, overrides = {}, launcherBaseUrl = baseUrl) {
  return fetch(`${launcherBaseUrl}/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      launch_code: launchCode,
      audience: AUDIENCE,
      instance_id: INSTANCE_ID,
      ...overrides,
    }),
  });
}

test('renders fixed tenant/user personas without placing tenant identity in the Agor URL', async () => {
  const response = await fetch(`${baseUrl}/dev-auth/?return_to=%2Fui%2Fb%2Fbranch-a`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const html = await response.text();
  for (const persona of HA_DEV_PERSONAS) {
    assert.match(html, new RegExp(persona.name));
  }
  assert.match(html, /name="return_to" value="\/ui\/b\/branch-a"/);
});

test('exchanges a selected persona once for a correctly scoped signed assertion', async () => {
  const selected = await selectPersona('globex-beatrice', 'globex', '/ui/');
  assert.equal(selected.status, 303);
  const location = new URL(selected.headers.get('location'));
  assert.equal(location.origin, 'http://127.0.0.1:3030');
  assert.equal(location.pathname, '/ui/');
  assert.equal(location.searchParams.has('tenant_id'), false);
  assert.equal(location.searchParams.has('persona'), false);

  const launchCode = launchCodeFrom(selected);
  const exchanged = await exchange(launchCode);
  assert.equal(exchanged.status, 200);
  const { assertion } = await exchanged.json();
  const [header, body, signature] = assertion.split('.');
  assert.equal(
    signature,
    createHmac('sha256', SHARED_SECRET).update(`${header}.${body}`).digest('base64url')
  );
  const claims = decodeJwtPayload(assertion);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(claims.sub, 'beatrice-admin');
  assert.equal(claims.tenant_id, 'globex');
  assert.equal(typeof claims.exp, 'number');
});

test('assertion contains the selected tenant and user claims', async () => {
  const selected = await selectPersona('acme-aaron', 'acme');
  const exchanged = await exchange(launchCodeFrom(selected));
  const { assertion } = await exchanged.json();
  const claims = decodeJwtPayload(assertion);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.aud, AUDIENCE);
  assert.equal(claims.instance_id, INSTANCE_ID);
  assert.equal(claims.provider, 'agor-ha-dev-launcher');
  assert.equal(claims.tenant_id, 'acme');
  assert.equal(claims.sub, 'aaron-member');
  assert.equal(claims.email, 'aaron@acme.example.test');
  assert.equal(claims.name, 'Aaron Member');
  assert.equal(claims.role, 'member');
  assert.equal(typeof claims.exp, 'number');
  assert.equal(typeof claims.iat, 'number');
  assert.equal(typeof claims.jti, 'string');
});

test('rejects mismatched tenant/persona selections and consumes launch codes once', async () => {
  const mismatched = await selectPersona('acme-alice', 'globex');
  assert.equal(mismatched.status, 400);

  const selected = await selectPersona();
  const code = launchCodeFrom(selected);
  assert.equal((await exchange(code)).status, 200);
  assert.equal((await exchange(code)).status, 401);
});

test('burns a code on an invalid audience and never redirects outside the HA origin', async () => {
  const selected = await selectPersona();
  const code = launchCodeFrom(selected);
  assert.equal((await exchange(code, { audience: 'wrong-audience' })).status, 401);
  assert.equal((await exchange(code)).status, 401);

  const redirect = new URL(
    buildLaunchRedirect('http://127.0.0.1:3030', 'https://evil.example/', 'opaque')
  );
  assert.equal(redirect.origin, 'http://127.0.0.1:3030');
  assert.equal(redirect.pathname, '/ui/');
});

test('bounds pending launch codes and evicts the oldest unexchanged identity', async () => {
  const bounded = createDevLauncher({
    publicOrigin: 'http://127.0.0.1:3030',
    issuer: ISSUER,
    audience: AUDIENCE,
    instanceId: INSTANCE_ID,
    sharedSecret: SHARED_SECRET,
    maxPendingCodes: 2,
  });
  await new Promise((resolve) => bounded.server.listen(0, '127.0.0.1', resolve));
  try {
    const address = bounded.server.address();
    assert(address && typeof address === 'object');
    const boundedBaseUrl = `http://127.0.0.1:${address.port}`;
    const first = launchCodeFrom(await selectPersona('acme-alice', 'acme', '/ui/', boundedBaseUrl));
    const second = launchCodeFrom(
      await selectPersona('acme-aaron', 'acme', '/ui/', boundedBaseUrl)
    );
    const third = launchCodeFrom(
      await selectPersona('globex-ben', 'globex', '/ui/', boundedBaseUrl)
    );

    assert.equal((await exchange(first, {}, boundedBaseUrl)).status, 401);
    assert.equal((await exchange(second, {}, boundedBaseUrl)).status, 200);
    assert.equal((await exchange(third, {}, boundedBaseUrl)).status, 200);
  } finally {
    await new Promise((resolve, reject) =>
      bounded.server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
