import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER } from './configuration.mjs';
import { run } from './launcher.mjs';
import { conn, fixture } from './test-fixture.mjs';

test('Start creates missing resources; repeated Start is read-only; Stop retains data; Start restarts compute', async () => {
  const f = fixture();
  assert.deepEqual(await f.action('start'), {
    app: 'https://test.up.railway.app/ui/',
    health: 'https://test.up.railway.app/health',
  });
  const volume = f.state.volumes[0].id;
  const before = f.mutations().length;
  await f.action('start');
  assert.equal(f.mutations().length, before);
  await f.action('stop');
  assert.equal(f.state.volumes[0].id, volume);
  await f.action('start');
  assert.equal(f.state.volumes[0].id, volume);
  assert.equal(f.state.deployments.length, 2);
  assert.equal(JSON.stringify(f.state.vars).includes(f.env.RAILWAY_API_TOKEN), false);
  assert.equal(f.state.vars.AGOR_ADMIN_PASSWORD, f.env.RAILWAY_AGOR_ADMIN_PASSWORD);
  assert.equal(f.state.vars.AGOR_ADMIN_REQUIRE_PASSWORD_CHANGE, 'false');
});
test('check/Stop of absent preview never provision', async () => {
  const f = fixture();
  await f.action('check');
  await f.action('stop');
  assert.equal(f.mutations().length, 0);
});
test('opt-in, authorized repository, workspace token and pushed source are required', async () => {
  const f = fixture();
  await assert.rejects(run('start', f.input, {}, f.request), /Opt in/);
  await assert.rejects(
    run('start', { ...f.input, repository: 'foreign/repo' }, f.env, f.request),
    /operator-authorized/
  );
  await assert.rejects(
    run('start', f.input, { ...f.env, RAILWAY_API_TOKEN: '' }, f.request),
    /token/
  );
  f.state.missing = true;
  await assert.rejects(f.action('start'), /Push it/);
  assert.equal(f.mutations().length, 0);
});
for (const key of [
  'tenantId',
  'workspaceId',
  'projectId',
  'repository',
  'branchId',
  'ref',
  'volumeId',
]) {
  test(`rejects ${key} ownership drift before Start/Stop/Nuke`, async () => {
    const f = fixture();
    await f.action('start');
    const marker = JSON.parse(f.state.vars[MARKER]);
    marker[key] = randomUUID();
    f.state.vars[MARKER] = JSON.stringify(marker);
    const before = f.mutations().length;
    for (const action of ['start', 'stop', 'nuke']) await assert.rejects(f.action(action));
    assert.equal(f.mutations().length, before);
  });
}
for (const kind of [
  'bootstrap',
  'shared-volume',
  'missing-volume',
  'duplicate-environment',
  'shared-secret',
]) {
  test(`rejects ${kind} before changing resources`, async () => {
    const f = fixture();
    await f.action('start');
    if (kind === 'bootstrap') delete f.state.vars[MARKER];
    if (kind === 'shared-volume')
      f.state.volumes[0].volumeInstances.edges.push({
        node: { id: randomUUID(), serviceId: randomUUID(), environmentId: randomUUID() },
      });
    if (kind === 'missing-volume') f.state.volumes = [];
    if (kind === 'duplicate-environment')
      f.state.environments.push({ ...f.state.environments[0], id: randomUUID() });
    if (kind === 'shared-secret') f.state.shared.RAILWAY_API_TOKEN = 'foreign-secret';
    const before = f.mutations().length;
    await assert.rejects(f.action('start'));
    assert.equal(f.mutations().length, before);
  });
}
for (const mutation of ['PreviewEnvironment', 'PreviewService', 'PreviewVolume', 'PreviewDomain']) {
  test(`reconciles visible resources after lost ${mutation} response without recreating`, async () => {
    const f = fixture();
    f.state.fail = mutation;
    await assert.rejects(f.action('start'), /No mutation was retried/);
    await f.action('start');
    assert.equal(f.mutations().filter((c) => c.q.includes(`${mutation}(`)).length, 1);
  });
}
test('unknown deployment outcome is not blindly retried', async () => {
  const f = fixture();
  f.state.fail = 'PreviewDeploy(';
  await assert.rejects(f.action('start'));
  await assert.rejects(f.action('start'), /Unconfirmed/);
  f.state.deployments = [];
  await assert.rejects(f.action('start'), /outcome remains unknown/);
  assert.equal(f.mutations().filter((c) => c.q.includes('PreviewDeploy(')).length, 1);
});
test('capacity check fails before creation and Logs redacts credentials/control records', async () => {
  const f = fixture();
  f.state.environments = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    name: `agor-other-${index}`,
  }));
  await assert.rejects(f.action('start'), /capacity/);
  assert.equal(f.mutations().length, 0);
  f.state.environments = [];
  await f.action('start');
  const logs = await f.action('logs');
  assert.equal(logs.message.includes(f.env.RAILWAY_API_TOKEN), false);
  assert.equal(logs.message.includes('AGOR_ENVIRONMENT_RESULT='), false);
});
test('only explicit Nuke removes owned resources', async () => {
  const f = fixture();
  await f.action('start');
  await f.action('nuke');
  assert.equal(f.state.volumes.length, 0);
  assert.equal(f.state.services.length, 0);
  assert.equal(f.state.environments.length, 0);
});
test('Start pins the published base, but an already active Start never resolves it again', async () => {
  const f = fixture();
  f.state.previewDigest = `sha256:${'b'.repeat(64)}`;
  await f.action('start');
  assert.ok(f.state.vars.AGOR_PREVIEW_BASE.endsWith(`@${f.state.previewDigest}`));
  assert.equal(f.state.vars.AGOR_RUNTIME_TARGET, 'railway-preview');
  f.state.registryStatus = 500;
  await f.action('start');
  assert.equal(f.state.registryCalls, 1);
});
test('Unsupported runtime sources fail before any network request', async () => {
  for (const shared of [false, true]) {
    for (const source of [
      { repository: 'example/agor', ref: 'feature' },
      { repository: 'preset-io/agor', ref: 'feature@preview' },
      { repository: 'preset-io/agor', ref: 'feature..preview' },
      { repository: 'preset-io/agor', ref: 'feature/' },
    ]) {
      const f = fixture();
      const config = JSON.parse(f.env.RAILWAY_PREVIEW_CONFIG);
      if (shared) {
        delete f.env.RAILWAY_PREVIEW_CONFIG;
        f.env.RAILWAY_AGOR_PROJECT_ID = config.projectId;
      } else {
        f.env.RAILWAY_PREVIEW_CONFIG = JSON.stringify({ ...config, repository: source.repository });
      }
      await assert.rejects(
        run('start', { ...f.input, ...source }, f.env, async () => {
          assert.fail('unsupported input reached the network');
        }),
        /Unsupported runtime source/
      );
    }
  }
});
test('Registry unavailable fails before any provider mutation', async () => {
  const f = fixture();
  f.state.registryStatus = 429;
  await assert.rejects(f.action('start'), /Cannot resolve/);
  assert.equal(f.mutations().length, 0);
});
test('Nuke refuses a detached volume moved to another environment or reattached', async () => {
  for (const field of ['environmentId', 'serviceId', 'mountPath']) {
    const f = fixture();
    await f.action('start');
    f.state.afterServiceDelete = () => {
      f.state.volumes[0].volumeInstances.edges[0].node[field] = randomUUID();
    };
    await assert.rejects(f.action('nuke'), /reattached/);
    assert.equal(f.state.volumes.length, 1);
    assert.equal(
      f.mutations().some((c) => c.q.includes('PreviewDeleteVolume')),
      false
    );
    // Receipt survives service removal, but never authorizes moved resources.
    await assert.rejects(f.action('start'), /cleanup is incomplete/);
    await assert.rejects(f.action('nuke'), /reattached/);
  }
});
test('Nuke accepts only confirmed soft deletion of the exact owned volume', async () => {
  for (const status of ['confirmed', 'unconfirmed']) {
    const f = fixture();
    await f.action('start');
    f.state.softDelete = status;
    if (status === 'confirmed') {
      await f.action('nuke');
      assert.equal(f.state.environments.length, 0);
    } else {
      await assert.rejects(f.action('nuke'), /not yet visible/);
      assert.equal(f.state.environments.length, 1);
      f.state.softDelete = 'confirmed';
      await f.action('nuke');
      assert.equal(f.state.environments.length, 0);
      assert.equal(f.mutations().filter((c) => c.q.includes('PreviewDeleteVolume(')).length, 1);
    }
  }
});
test('plain Node loads launcher; lifecycle commands never install dependencies', () => {
  try {
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./launcher.mjs', import.meta.url)),
        'check',
        '--binding',
        randomUUID(),
        '--repository',
        'owner/repo',
        '--ref',
        'feature',
      ],
      { env: {}, stdio: 'pipe' }
    );
    assert.fail('configuration required');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /Opt in/);
  }
  const yaml = readFileSync(new URL('../../../.agor.yml', import.meta.url), 'utf8');
  assert.equal([...yaml.matchAll(/^ {4}railway-sqlite:/gm)].length, 1);
  assert.doesNotMatch(yaml, /railway-auto/);
  const config = yaml.split('railway-sqlite:')[1].split('    codespaces-sqlite:')[0];
  assert.doesNotMatch(config, /npm|pnpm|npx|tsx/);
  for (const action of ['start', 'stop', 'logs', 'nuke'])
    assert.ok(config.includes(`launcher.mjs ${action}`));
});

for (const [mutation, collection] of [
  ['PreviewVolume', 'volumes'],
  ['PreviewDomain', 'domains'],
]) {
  test(`unknown ${mutation} outcome without read-back never repeats creation`, async () => {
    const f = fixture();
    f.state.fail = mutation;
    await assert.rejects(f.action('start'), /No mutation was retried/);
    f.state[collection] = [];
    const before = f.mutations().length;
    await assert.rejects(f.action('start'), /outcome remains unknown/);
    assert.equal(f.mutations().filter((c) => c.q.includes(`${mutation}(`)).length, 1);
    // Domain reconciliation may refresh the volume/service receipt, but cannot create again.
    assert.ok(
      f
        .mutations()
        .slice(before)
        .every((c) => c.q.includes('PreviewMarker'))
    );
  });
}

test('wrong provider workspace refuses every lifecycle action before mutation', async () => {
  const f = fixture();
  const request = async (url, options) => {
    const response = await f.request(url, options);
    const body = await response.json();
    if (body.data?.project) body.data.project.workspaceId = randomUUID();
    return new Response(JSON.stringify(body));
  };
  for (const action of ['start', 'stop', 'nuke'])
    await assert.rejects(run(action, f.input, f.env, request), /authorization mismatch/);
  assert.equal(f.mutations().length, 0);
});

function simpleFixture() {
  const f = fixture();
  delete f.env.RAILWAY_PREVIEW_CONFIG;
  f.env.RAILWAY_AGOR_PROJECT_ID = f.config.projectId;
  return f;
}
test('project ID only discovers workspace and preserves unrelated bootstrap through Start/Stop/Nuke', async () => {
  const f = simpleFixture();
  const environment = { id: randomUUID(), name: 'production' };
  const service = { id: randomUUID(), name: 'bootstrap' };
  service.serviceInstances = conn([
    { id: randomUUID(), serviceId: service.id, environmentId: environment.id },
  ]);
  const volume = {
    id: randomUUID(),
    volumeInstances: conn([
      {
        id: randomUUID(),
        serviceId: service.id,
        environmentId: environment.id,
        mountPath: '/home/agor/.agor',
      },
    ]),
  };
  f.state.environments.push(environment);
  f.state.services.push(service);
  f.state.volumes.push(volume);
  await f.action('start');
  const before = f.mutations().length;
  await f.action('start');
  assert.equal(f.mutations().length, before);
  await f.action('stop');
  await f.action('nuke');
  assert.deepEqual(f.state.environments, [environment]);
  assert.deepEqual(f.state.services, [service]);
  assert.deepEqual(f.state.volumes, [volume]);
  assert.ok(
    f.state.calls.every(
      (c) => !JSON.stringify(c.v).includes(service.id) && !JSON.stringify(c.v).includes(volume.id)
    )
  );
});
for (const key of ['workspaceId', 'projectId', 'repository', 'branchId', 'ref']) {
  test(`simple setup rejects ${key} marker mismatch`, async () => {
    const f = simpleFixture();
    await f.action('start');
    const record = JSON.parse(f.state.vars[MARKER]);
    record[key] = randomUUID();
    f.state.vars[MARKER] = JSON.stringify(record);
    const before = f.mutations().length;
    for (const action of ['start', 'stop', 'nuke']) await assert.rejects(f.action(action));
    assert.equal(f.mutations().length, before);
  });
}
test('simple setup refuses a volume shared with another environment', async () => {
  const f = simpleFixture();
  await f.action('start');
  f.state.volumes[0].volumeInstances.edges.push({
    node: { id: randomUUID(), serviceId: randomUUID(), environmentId: randomUUID() },
  });
  const before = f.mutations().length;
  for (const action of ['start', 'stop', 'nuke']) await assert.rejects(f.action(action));
  assert.equal(f.mutations().length, before);
});
test('simple setup validates project ID and refuses conflicting legacy config', async () => {
  const f = simpleFixture();
  f.env.RAILWAY_AGOR_PROJECT_ID = 'https://railway.com/project/example';
  await assert.rejects(f.action('start'), /UUID/);
  const legacy = fixture();
  legacy.env.RAILWAY_AGOR_PROJECT_ID = randomUUID();
  await assert.rejects(legacy.action('start'), /conflict/);
  assert.equal(f.state.calls.length + legacy.state.calls.length, 0);
});

test('simple names fit provider validation and unknown service-row creation is not repeated', async () => {
  const f = simpleFixture();
  f.state.fail = 'PreviewServiceRow';
  await assert.rejects(f.action('start'));
  assert.ok(f.state.environments[0].name.length <= 32);
  const before = f.mutations().length;
  await assert.rejects(f.action('start'), /Foreign\/shared/);
  assert.equal(f.mutations().length, before);
});

test('live region and limit response shapes are accepted without repeated limit updates', async () => {
  const f = simpleFixture();
  await f.action('start');
  await f.action('stop');
  const real = f.request;
  const request = async (url, options) => {
    const response = await real(url, options);
    if (!options?.body) return response;
    const query = JSON.parse(options.body).query;
    const body = await response.json();
    if (query.includes('PreviewDetails')) {
      body.data.serviceInstance.region = null;
      body.data.environment.config = {
        services: {
          [f.state.services[0].id]: { deploy: { multiRegionConfig: { sfo: { numReplicas: 1 } } } },
        },
      };
    }
    if (query.includes('PreviewLimits'))
      body.data.serviceInstanceLimits = {
        containers: { cpu: 2, memoryBytes: 8000000000, pidLimit: 1000 },
      };
    return new Response(JSON.stringify(body));
  };
  const before = f.mutations().length;
  await run('start', f.input, f.env, request);
  assert.ok(
    !f
      .mutations()
      .slice(before)
      .some((c) => c.q.includes('PreviewLimitSet'))
  );
});
