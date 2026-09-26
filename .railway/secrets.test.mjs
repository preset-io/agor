import assert from 'node:assert/strict';
import test from 'node:test';
import { setBootstrapPassword } from './secrets.mjs';

const env = {
  RAILWAY_TOKEN: 'synthetic-project-token',
  RAILWAY_AGOR_ADMIN_PASSWORD: 'synthetic-password-for-tests',
};

test('secret transfer is scoped, redirect-free, and never deploys or resets accounts', async () => {
  let calls = 0;
  await setBootstrapPassword(env, async (url, options) => {
    calls++;
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Project-Access-Token'], env.RAILWAY_TOKEN);
    const { variables } = JSON.parse(options.body);
    assert.deepEqual(variables.input, {
      projectId: 'aa86ab4f-8ccd-466f-b29c-27a818594081',
      environmentId: 'c5cfea2f-c938-4ad4-a285-73b2c77469fc',
      serviceId: '28acddc0-1370-4b2e-89d0-37230b205380',
      name: 'AGOR_ADMIN_PASSWORD',
      value: env.RAILWAY_AGOR_ADMIN_PASSWORD,
      skipDeploys: true,
    });
    return Response.json({ data: { variableUpsert: true } });
  });
  assert.equal(calls, 1);
});

test('project token precedence matches the lifecycle launcher', async () => {
  await setBootstrapPassword(
    { ...env, RAILWAY_API_KEY: 'preferred-project-token' },
    async (_url, options) => {
      assert.equal(options.headers['Project-Access-Token'], 'preferred-project-token');
      return Response.json({ data: { variableUpsert: true } });
    }
  );
});

test('provider and transport errors cannot disclose credentials', async () => {
  for (const request of [
    async () => {
      throw new Error(JSON.stringify(env));
    },
    async () => Response.json({ errors: [{ message: JSON.stringify(env) }] }),
    async () => new Response(JSON.stringify(env), { status: 403 }),
  ]) {
    await assert.rejects(setBootstrapPassword(env, request), (error) => {
      assert.ok(!error.message.includes(env.RAILWAY_TOKEN));
      assert.ok(!error.message.includes(env.RAILWAY_AGOR_ADMIN_PASSWORD));
      return true;
    });
  }
});

test('missing or invalid input fails before contacting Railway', async () => {
  for (const input of [
    {},
    { RAILWAY_TOKEN: 'synthetic' },
    { ...env, RAILWAY_AGOR_ADMIN_PASSWORD: 'short' },
  ]) {
    await assert.rejects(setBootstrapPassword(input, () => assert.fail('unexpected network call')));
  }
});
