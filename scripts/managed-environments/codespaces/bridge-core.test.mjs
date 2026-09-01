import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCodespacesAccess } from './bridge-contract.mjs';
import {
  createResourceMarker,
  ManagedRemoteEnvironmentBridge,
  RemoteBridgeError,
  sanitizeProviderOutput,
} from './bridge-core.mjs';

const IDS = Object.freeze({
  tenant: '0199443a-7aa0-7000-8000-000000000001',
  branch: '0199443a-7aa0-7000-8000-000000000002',
  actor: '0199443a-7aa0-7000-8000-000000000003',
  owner: '0199443a-7aa0-7000-8000-000000000004',
  operation: '0199443a-7aa0-7000-8000-000000000005',
});

function request(overrides = {}) {
  return {
    action: 'start',
    tenantId: IDS.tenant,
    branchId: IDS.branch,
    actorUserId: IDS.actor,
    credentialOwnerUserId: IDS.owner,
    credentialOwnerLogin: 'octo-owner',
    operationId: IDS.operation,
    generation: 7,
    repository: 'preset-io/agor',
    providerRepositoryId: '42',
    ref: 'refs/heads/codespaces-sqlite-variant',
    isAttemptCurrent: async () => true,
    ...overrides,
  };
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (delay) => {
      value += delay;
    },
  };
}

class FakeProvider {
  constructor({ neverReady = false } = {}) {
    this.neverReady = neverReady;
    this.resources = new Map();
    this.createCalls = [];
    this.startCalls = [];
    this.stopCalls = [];
    this.deleteCalls = [];
    this.refInputs = [];
    this.nextUrl = 'https://fresh-3000.app.github.dev/';
    this.logOutput = 'creation complete';
    this.repositoryResult = { id: 42, fullName: 'preset-io/agor' };
  }

  async viewer() {
    return { login: 'octo-owner' };
  }

  async repository() {
    return this.repositoryResult;
  }

  async list({ repositoryId }) {
    return [...this.resources.values()].filter(
      (resource) => String(resource.repositoryId) === String(repositoryId)
    );
  }

  async create(input) {
    this.createCalls.push(input);
    this.refInputs.push(input.ref);
    const resource = {
      name: `codespace-${this.createCalls.length}`,
      marker: input.marker,
      ownerLogin: 'octo-owner',
      repositoryId: 42,
      repository: 'preset-io/agor',
      ref: input.ref,
      state: 'Starting',
      url: this.nextUrl,
    };
    this.resources.set(resource.name, resource);
    return { ...resource };
  }

  async get(name) {
    const resource = this.resources.get(name);
    if (!resource) throw new Error('not found');
    if (!this.neverReady && resource.state === 'Starting') resource.state = 'Available';
    return { ...resource };
  }

  async start(name, context) {
    this.startCalls.push({ name, context });
    const resource = this.resources.get(name);
    resource.state = 'Starting';
    return { ...resource };
  }

  async stop(name, context) {
    this.stopCalls.push({ name, context });
    const resource = this.resources.get(name);
    resource.state = 'Shutdown';
    return { ...resource };
  }

  async delete(name, context) {
    this.deleteCalls.push({ name, context });
    this.resources.delete(name);
  }

  async logs() {
    return this.logOutput;
  }

  async access(name) {
    const resource = this.resources.get(name);
    return {
      editorUrl: `https://${name}.github.dev/`,
      accessUrls: [{ name: 'app', url: resource.url, visibility: 'private' }],
    };
  }
}

function createBridge(provider, timeouts = {}) {
  const clock = fakeClock();
  return new ManagedRemoteEnvironmentBridge({
    provider,
    accessValidator: validateCodespacesAccess,
    ...clock,
    timeouts: { startMs: 100, stopMs: 100, pollMs: 10, ...timeouts },
  });
}

test('start creates the exact repository/ref and waits for a fresh access URL', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);

  const result = await bridge.execute(request({ bearerToken: 'must-not-cross-the-contract' }));

  assert.equal(result.status, 'running');
  assert.equal(provider.createCalls.length, 1);
  assert.equal(provider.createCalls[0].repositoryId, 42);
  assert.equal(provider.refInputs[0], 'refs/heads/codespaces-sqlite-variant');
  assert.equal(result.accessUrls[0].url, 'https://fresh-3000.app.github.dev/');
  assert.equal(result.binding.marker, createResourceMarker(IDS.tenant, IDS.branch));
  assert.equal(provider.createCalls[0].actorUserId, IDS.actor);
  assert.equal(provider.createCalls[0].credentialOwnerUserId, IDS.owner);
  assert.equal('bearerToken' in provider.createCalls[0], false);
});

test('two concurrent Play requests serialize and create only one resource', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);

  const [first, second] = await Promise.all([bridge.execute(request()), bridge.execute(request())]);

  assert.equal(provider.createCalls.length, 1);
  assert.equal(first.binding.resourceName, second.binding.resourceName);
});

test('tenant identity participates in binding so another tenant cannot adopt a resource', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  const first = await bridge.execute(request());
  const second = await bridge.execute(
    request({ tenantId: '0199443a-7aa0-7000-8000-000000000099' })
  );

  assert.equal(provider.createCalls.length, 2);
  assert.notEqual(first.binding.marker, second.binding.marker);
  assert.notEqual(first.binding.resourceName, second.binding.resourceName);
});

test('start resumes a stopped resource and stop is idempotent', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  const started = await bridge.execute(request());
  const resource = provider.resources.get(started.binding.resourceName);
  resource.state = 'Shutdown';

  await bridge.execute(request());
  const stopped = await bridge.execute(request({ action: 'stop' }));
  const stoppedAgain = await bridge.execute(request({ action: 'stop' }));

  assert.equal(provider.createCalls.length, 1);
  assert.equal(provider.startCalls.length, 1);
  assert.equal(provider.stopCalls.length, 1);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stoppedAgain.status, 'stopped');
});

test('health reconciles provider reality and nuke removes only the validated resource', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  const started = await bridge.execute(request());

  const healthy = await bridge.execute(request({ action: 'health' }));
  const deleted = await bridge.execute(request({ action: 'nuke' }));
  const absent = await bridge.execute(request({ action: 'health', generation: 8 }));

  assert.equal(healthy.healthy, true);
  assert.equal(healthy.binding.resourceName, started.binding.resourceName);
  assert.equal(deleted.status, 'deleted');
  assert.equal(provider.deleteCalls[0].name, started.binding.resourceName);
  assert.equal(provider.deleteCalls[0].context.operationId, IDS.operation);
  assert.equal(absent.status, 'absent');
  assert.equal(absent.healthy, false);
});

test('rediscovery ignores a stale resource hint and publishes a recreated URL', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  const first = await bridge.execute(
    request({
      lastKnownResourceName: 'deleted-resource',
      cachedUrl: 'https://stale.app.github.dev/',
    })
  );
  await bridge.execute(request({ action: 'nuke' }));
  provider.nextUrl = 'https://recreated-3000.app.github.dev/';

  const recreated = await bridge.execute(
    request({
      lastKnownResourceName: first.binding.resourceName,
      cachedUrl: first.accessUrls[0].url,
      generation: 8,
    })
  );

  assert.equal(provider.createCalls.length, 2);
  assert.notEqual(recreated.binding.resourceName, first.binding.resourceName);
  assert.equal(recreated.accessUrls[0].url, 'https://recreated-3000.app.github.dev/');
});

test('a renamed last-known resource freezes instead of creating a duplicate', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  const first = await bridge.execute(request());
  provider.resources.get(first.binding.resourceName).marker = 'renamed-outside-agor';

  await assert.rejects(
    bridge.execute(request({ lastKnownResourceName: first.binding.resourceName })),
    (error) => {
      assert.equal(error.code, 'RESOURCE_MARKER_MISMATCH');
      return true;
    }
  );
  assert.equal(provider.createCalls.length, 1);
});

test('structured refs are passed exactly and never evaluated as shell text', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  const hostileLookingRef = 'refs/heads/feature/$(touch pwned);quoted`value`';

  await bridge.execute(request({ ref: hostileLookingRef }));

  assert.equal(provider.refInputs[0], hostileLookingRef);
});

test('start fails with a bounded timeout instead of reporting false readiness', async () => {
  const provider = new FakeProvider({ neverReady: true });
  const bridge = createBridge(provider, { startMs: 25, pollMs: 10 });

  await assert.rejects(bridge.execute(request()), (error) => {
    assert.equal(error.code, 'START_TIMEOUT');
    return true;
  });
  assert.equal(provider.createCalls.length, 1);
});

test('mismatched repository/ref identities fail closed before mutation', async () => {
  const provider = new FakeProvider();
  const marker = createResourceMarker(IDS.tenant, IDS.branch);
  provider.resources.set('wrong-ref', {
    name: 'wrong-ref',
    marker,
    ownerLogin: 'octo-owner',
    repositoryId: 42,
    repository: 'preset-io/agor',
    ref: 'refs/heads/other',
    state: 'Available',
    url: 'https://wrong-ref-3000.app.github.dev/',
  });
  const bridge = createBridge(provider);

  await assert.rejects(bridge.execute(request()), (error) => {
    assert.equal(error.code, 'RESOURCE_REF_MISMATCH');
    return true;
  });
  assert.equal(provider.createCalls.length, 0);
  assert.equal(provider.startCalls.length, 0);
});

test('credential-owner mismatch and ambiguous provider bindings fail closed', async () => {
  const ownerMismatchProvider = new FakeProvider();
  ownerMismatchProvider.viewer = async () => ({ login: 'different-owner' });
  const ownerMismatchBridge = createBridge(ownerMismatchProvider);

  await assert.rejects(ownerMismatchBridge.execute(request()), (error) => {
    assert.equal(error.code, 'CREDENTIAL_OWNER_MISMATCH');
    return true;
  });
  assert.equal(ownerMismatchProvider.createCalls.length, 0);

  const ambiguousProvider = new FakeProvider();
  const ambiguousBridge = createBridge(ambiguousProvider);
  const started = await ambiguousBridge.execute(request());
  const original = ambiguousProvider.resources.get(started.binding.resourceName);
  ambiguousProvider.resources.set('duplicate', { ...original, name: 'duplicate' });

  await assert.rejects(ambiguousBridge.execute(request({ action: 'health' })), (error) => {
    assert.equal(error.code, 'AMBIGUOUS_RESOURCE');
    return true;
  });
  assert.equal(ambiguousProvider.createCalls.length, 1);
});

test('stale attempts cannot publish success and nuke revalidates before deletion', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  let currentChecks = 0;

  await assert.rejects(
    bridge.execute(
      request({
        isAttemptCurrent: async () => {
          currentChecks += 1;
          return currentChecks < 3;
        },
      })
    ),
    (error) => {
      assert.equal(error.code, 'STALE_ATTEMPT');
      return true;
    }
  );
  assert.equal(provider.createCalls.length, 1);

  const resource = [...provider.resources.values()][0];
  resource.ref = 'refs/heads/other';
  await assert.rejects(bridge.execute(request({ action: 'nuke' })), (error) => {
    assert.equal(error.code, 'RESOURCE_REF_MISMATCH');
    return true;
  });
  assert.equal(provider.deleteCalls.length, 0);
});

test('logs are bounded and strip facts, GitHub tokens, authorization, and URL secrets', async () => {
  const provider = new FakeProvider();
  const bridge = createBridge(provider);
  await bridge.execute(request());
  provider.logOutput = [
    'AGOR_FACT url=https://attacker.example',
    'github_pat_1234567890abcdef',
    'Authorization Bearer ghp_1234567890abcdef',
    'https://user:password@example.test/path?token=secret',
  ].join('\n');

  const result = await bridge.execute(request({ action: 'logs' }));

  assert.equal(result.logKind, 'provider_creation');
  assert.doesNotMatch(result.logs, /AGOR_FACT|attacker|123456|password|token=secret/i);
  assert.match(result.logs, /REDACTED/);
  assert.equal(sanitizeProviderOutput('line\n'.repeat(150)).split('\n').length, 100);
});

test('access URLs fail closed on non-GitHub hosts or secret-bearing queries', async () => {
  const provider = new FakeProvider();
  provider.nextUrl = 'https://fresh-3000.app.github.dev/?token=secret';
  const bridge = createBridge(provider);

  await assert.rejects(bridge.execute(request()), (error) => {
    assert.equal(error.code, 'INVALID_ACCESS_URL');
    return true;
  });
});

test('provider failures are sanitized and individual provider calls time out', async () => {
  const failingProvider = new FakeProvider();
  failingProvider.repository = async () => {
    throw new Error('github_pat_1234567890 should never escape');
  };
  const failingBridge = createBridge(failingProvider);

  await assert.rejects(failingBridge.execute(request()), (error) => {
    assert.equal(error.code, 'PROVIDER_REQUEST_FAILED');
    assert.doesNotMatch(error.message, /github_pat|1234567890/);
    return true;
  });

  const hangingProvider = new FakeProvider();
  hangingProvider.viewer = async () => new Promise(() => {});
  const hangingBridge = createBridge(hangingProvider, { providerCallMs: 5 });
  await assert.rejects(hangingBridge.execute(request()), (error) => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT');
    return true;
  });
  assert.equal(hangingProvider.createCalls.length, 0);
});

test('control characters in refs and missing attempt fencing are rejected', async () => {
  const bridge = createBridge(new FakeProvider());

  await assert.rejects(
    bridge.execute(request({ ref: 'refs/heads/main\nmalicious' })),
    RemoteBridgeError
  );
  await assert.rejects(
    bridge.execute(request({ isAttemptCurrent: undefined })),
    (error) => error.code === 'INVALID_REQUEST'
  );
});
