import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RailwayClient, RailwayPreview, selectBinding } from './launcher.mjs';

const bindings = JSON.parse(await readFile(new URL('./bindings.json', import.meta.url), 'utf8'));
const binding = Object.keys(bindings)[0];
const target = selectBinding(bindings, { binding, ...bindings[binding] });
function snapshot() {
  return {
    projectToken: { projectId: target.projectId, environmentId: target.environmentId },
    environment: {
      projectId: target.projectId,
      deploymentTriggers: { edges: [] },
      volumeInstances: {
        edges: [
          {
            node: {
              volumeId: target.volumeId,
              serviceId: target.serviceId,
              mountPath: '/home/agor/.agor',
            },
          },
        ],
      },
    },
    serviceInstance: {
      source: { repo: target.repository },
      domains: { serviceDomains: [{ domain: target.domain, targetPort: 3030 }] },
    },
    variables: {
      AGOR_MANAGED_BRANCH_ID: binding,
      AGOR_SOURCE_BRANCH: target.ref,
      AGOR_SOURCE_REPO: `https://github.com/${target.repository}.git`,
    },
  };
}
const env = { RAILWAY_AGOR_ADMIN_PASSWORD: 'synthetic-password-12345' };
function fake(handler) {
  const calls = [];
  return {
    calls,
    async query(q, v) {
      calls.push({ q, v });
      return handler(q, v);
    },
  };
}
const inventory = (nodes) => ({
  deployments: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false } },
});

test('binding rejects foreign branches, refs and shared resources before network access', () => {
  assert.throws(() => selectBinding(bindings, { ...target, binding: 'foreign' }));
  assert.throws(() => selectBinding(bindings, { ...target, ref: 'main' }));
  assert.throws(() => selectBinding({ ...bindings, another: bindings[binding] }, target));
});

test('every action revalidates project-token scope, source marker, volume and trigger', async () => {
  for (const change of [
    (s) => {
      s.projectToken.environmentId = 'foreign';
    },
    (s) => {
      s.variables.AGOR_MANAGED_BRANCH_ID = 'foreign';
    },
    (s) => {
      s.environment.volumeInstances.edges[0].node.volumeId = 'foreign';
    },
    (s) => {
      s.environment.deploymentTriggers.edges = [
        {
          node: {
            serviceId: target.serviceId,
            repository: target.repository,
            branch: 'main',
            provider: 'github',
          },
        },
      ];
    },
  ]) {
    const s = snapshot();
    change(s);
    const client = fake(() => s);
    await assert.rejects(new RailwayPreview(client, target, { env }).start());
    assert.equal(client.calls.length, 1);
  }
});

test('start configures secrets without replacement/deployment, deploys once and reports tiny URLs', async () => {
  let lists = 0;
  const client = fake((q, v) => {
    if (q.includes('query Inspect')) return snapshot();
    if (q.includes('mutation Variables')) {
      assert.equal(v.input.skipDeploys, true);
      assert.equal(v.input.replace, false);
      assert.equal(v.input.variables.AGOR_ADMIN_PASSWORD, env.RAILWAY_AGOR_ADMIN_PASSWORD);
      return {};
    }
    if (q.includes('mutation Trigger')) return { deploymentTriggerCreate: { id: 'trigger' } };
    if (q.includes('query Deployments')) {
      lists++;
      return inventory([]);
    }
    if (q.includes('mutation Deploy')) return { serviceInstanceDeployV2: 'deployment' };
    if (q.includes('query Deployment')) return { deployment: { status: 'SUCCESS' } };
    throw new Error(q);
  });
  const preview = new RailwayPreview(client, target, {
    env,
    request: async (url) => ({
      ok: true,
      json: async () =>
        url.includes('api.github.com') ? { sha: 'a'.repeat(40) } : { status: 'ok' },
    }),
  });
  assert.deepEqual(await preview.start(), {
    app: `https://${target.domain}/ui/`,
    health: `https://${target.domain}/health`,
  });
  assert.equal(lists, 1);
  assert(!client.calls.some((c) => c.q.includes('deploymentTriggerCreate')));
  assert.equal(client.calls.filter((c) => c.q.includes('mutation Deploy')).length, 1);
});

test('start adopts an in-flight deployment rather than creating a duplicate', async () => {
  const client = fake((q) => {
    if (q.includes('query Inspect')) return snapshot();
    if (q.includes('query Deployments')) return inventory([{ id: 'existing', status: 'BUILDING' }]);
    if (q.includes('query Deployment')) return { deployment: { status: 'SUCCESS' } };
    if (q.includes('mutation Deploy')) assert.fail('duplicate deploy');
    return {};
  });
  await new RailwayPreview(client, target, {
    env,
    request: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }),
  }).start();
});

test('Stop disables push trigger first, cancels queued work, removes compute and confirms empty inventory', async () => {
  let disabled = false,
    drained = false;
  const client = fake((q) => {
    if (q.includes('query Inspect')) {
      const s = snapshot();
      if (!disabled)
        s.environment.deploymentTriggers.edges = [
          {
            node: {
              id: 'trigger',
              serviceId: target.serviceId,
              repository: target.repository,
              branch: target.ref,
              provider: 'github',
            },
          },
        ];
      return s;
    }
    if (q.includes('mutation Disable')) {
      disabled = true;
      return {};
    }
    if (q.includes('query Deployments')) {
      assert.equal(disabled, true);
      return inventory(
        drained
          ? []
          : [
              { id: 'queue', status: 'BUILDING' },
              { id: 'live', status: 'SUCCESS' },
            ]
      );
    }
    if (q.includes('deploymentCancel')) return {};
    if (q.includes('deploymentRemove')) {
      drained = true;
      return {};
    }
    assert.fail(q);
  });
  const preview = new RailwayPreview(client, target, { wait: async () => {} });
  await preview.stop();
  await preview.stop();
  assert(!client.calls.some((c) => /volumeDelete|serviceDelete|environmentDelete/.test(c.q)));
});

test('read-only logs neither deploy nor change variables and redact control records/secrets', async () => {
  const client = fake((q) => {
    assert(q.startsWith('query'));
    if (q.includes('query Inspect')) return snapshot();
    if (q.includes('query Deployments')) return inventory([{ id: 'old', status: 'REMOVED' }]);
    return {
      buildLogs: [],
      deploymentLogs: [
        { message: `${env.RAILWAY_AGOR_ADMIN_PASSWORD}\nAGOR_ENVIRONMENT_RESULT={}\nnormal` },
      ],
    };
  });
  const output = await new RailwayPreview(client, target, { env }).logs();
  assert(!output.includes(env.RAILWAY_AGOR_ADMIN_PASSWORD));
  assert(!output.includes('AGOR_ENVIRONMENT_RESULT='));
  assert(output.includes('normal'));
});

test('API uses fixed endpoint/project header, refuses redirects and hides provider errors', async () => {
  const secret = 'synthetic-provider-token';
  const client = new RailwayClient(secret, {
    request: async (url, options) => {
      assert.equal(url, 'https://backboard.railway.com/graphql/v2');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Project-Access-Token'], secret);
      return { ok: true, json: async () => ({ errors: [{ message: secret }] }) };
    },
  });
  await assert.rejects(client.query('query {}'), (error) => !error.message.includes(secret));
});

test('persisted replacement is accepted only with matching seed/branch and ready state', async () => {
  const s = snapshot();
  const replacement = '22222222-2222-2222-2222-222222222222';
  s.environment.volumeInstances.edges[0].node.volumeId = replacement;
  const state = {
    version: 1,
    binding,
    seedVolumeId: target.volumeId,
    volumeId: replacement,
    phase: 'ready',
  };
  s.variables.AGOR_MANAGED_VOLUME_STATE = JSON.stringify(state);
  const preview = new RailwayPreview(
    fake(() => s),
    target
  );
  assert.equal((await preview.inspect()).volumeId, replacement);
  for (const change of [
    { phase: 'creating' },
    { binding: 'foreign' },
    { seedVolumeId: replacement },
  ]) {
    s.variables.AGOR_MANAGED_VOLUME_STATE = JSON.stringify({ ...state, ...change });
    await assert.rejects(preview.inspect());
  }
});

test('workspace API credential uses Bearer only and is never part of service variables', async () => {
  const c = new RailwayClient('synthetic-operator-token', {
    accountToken: true,
    request: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-operator-token');
      assert.equal(options.headers['Project-Access-Token'], undefined);
      return { ok: true, json: async () => ({ data: {} }) };
    },
  });
  await c.query('query {}');
  const p = new RailwayPreview(
    fake((_q, v) => {
      assert.equal(v.input.variables.RAILWAY_API_TOKEN, undefined);
      assert.equal(v.input.variables.RAILWAY_API_KEY, undefined);
      return {};
    }),
    target,
    { env: { ...env, RAILWAY_API_TOKEN: 'synthetic-operator-token' } }
  );
  await p.setVariables();
});

test('Stop can drain compute during an interrupted reset without adopting/deleting a volume', async () => {
  const s = snapshot();
  s.variables.AGOR_MANAGED_VOLUME_STATE = JSON.stringify({
    version: 1,
    binding,
    seedVolumeId: target.volumeId,
    volumeId: target.volumeId,
    phase: 'creating',
  });
  s.environment.volumeInstances.edges = [];
  let removed = false;
  const client = fake((q) => {
    if (q.includes('query Inspect')) return s;
    if (q.includes('query Deployments'))
      return inventory(removed ? [] : [{ id: 'owned-deployment', status: 'SUCCESS' }]);
    if (q.includes('deploymentRemove')) {
      removed = true;
      return {};
    }
    throw new Error('Unexpected mutation');
  });
  const preview = new RailwayPreview(client, target, { wait: async () => {} });
  await assert.rejects(preview.start());
  await preview.stop();
  assert.equal(removed, true);
  assert.equal(
    client.calls.some((c) => c.q.includes('volumeDelete') || c.q.includes('volumeCreate')),
    false
  );
});
