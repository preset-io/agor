import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  CodespaceController,
  environmentResult,
  GitHubCodespacesClient,
  LauncherError,
  markerFor,
  parseArgs,
  redact,
  StateStore,
  validateResource,
} from './agor-codespace-launcher.mjs';

const REPOSITORY = 'preset-io/agor';
const REF = 'codespaces-sqlite-variant';
const BINDING = '01999999-1111-7222-8333-444444444444';
const execFileAsync = promisify(execFile);

function resource({
  name = 'octocat-agor-new123',
  state = 'Available',
  owner = 'octocat',
  repository = REPOSITORY,
  ref = REF,
  marker = markerFor(REPOSITORY, BINDING),
} = {}) {
  return {
    name,
    display_name: marker,
    state,
    owner: { login: owner },
    repository: { full_name: repository, id: 123 },
    git_status: { ref },
    web_url: `https://${name}.github.dev`,
  };
}

function ports(name = 'octocat-agor-new123', visibility = 'private') {
  return [
    {
      sourcePort: 3000,
      visibility,
      label: 'Agor daemon',
      browseUrl: `https://${name}-3000.app.github.dev`,
    },
    {
      sourcePort: 5000,
      visibility,
      label: 'Agor UI',
      browseUrl: `https://${name}-5000.app.github.dev`,
    },
  ];
}

class FakeClient {
  constructor(resources = []) {
    this.resources = [...resources];
    this.created = 0;
    this.started = [];
    this.stopped = [];
    this.deleted = [];
    this.creationLogCalls = [];
    this.runtimeLogCalls = [];
    this.portVisibility = 'private';
    this.visibilityCalls = [];
    this.bootstrapCalls = [];
    this.syncCalls = [];
    this.verifyCalls = [];
    this.remoteHealthy = true;
    this.healthResponses = [];
    this.events = [];
  }

  async viewer() {
    return 'octocat';
  }

  async repository(repository) {
    return { full_name: repository, id: 123 };
  }

  async resolveRef() {
    return 'a'.repeat(40);
  }

  async listCodespaces() {
    return [...this.resources];
  }

  async createCodespace(repository, ref, displayName) {
    this.created += 1;
    const created = resource({ marker: displayName, repository, ref });
    this.resources.push(created);
    return created;
  }

  async getCodespace(name) {
    return this.resources.find((item) => item.name === name);
  }

  async startCodespace(name) {
    this.started.push(name);
    for (const item of this.resources) if (item.name === name) item.state = 'Available';
  }

  async stopCodespace(name) {
    this.stopped.push(name);
    for (const item of this.resources) if (item.name === name) item.state = 'Shutdown';
  }

  async deleteCodespace(name) {
    this.deleted.push(name);
    this.resources = this.resources.filter((item) => item.name !== name);
  }

  async listPorts(name) {
    return ports(name, this.portVisibility);
  }

  async setPortVisibility(name, targetPorts, visibility) {
    this.visibilityCalls.push({ name, ports: [...targetPorts], visibility });
    this.portVisibility = visibility;
  }

  async remoteHealth() {
    this.events.push('health');
    if (this.healthResponses.length > 0) return this.healthResponses.shift();
    return this.remoteHealthy;
  }

  async creationLogs(name) {
    this.creationLogCalls.push(name);
    return 'safe creation log\n';
  }

  async runtimeLogs(name) {
    this.runtimeLogCalls.push(name);
    return 'safe runtime log\n';
  }

  async runBootstrap(name, repository, options) {
    this.events.push('bootstrap');
    this.bootstrapCalls.push({ name, repository, options });
    this.remoteHealthy = true;
  }

  async syncWorkspace(name, repository, ref, revision, options) {
    this.events.push('sync');
    this.syncCalls.push({ name, repository, ref, revision, options });
    this.syncedRevision = revision;
    this.remoteHealthy = true;
  }

  async verifyWorkspaceRevision(name, repository, ref, revision) {
    this.events.push('verify');
    this.verifyCalls.push({ name, repository, ref, revision });
    return this.syncedRevision ?? revision;
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agor-codespaces-node-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory, REPOSITORY, BINDING);
  return { directory, store };
}

function controller(
  client,
  store,
  { monotonic = () => performance.now() / 1_000, portVisibility = 'preserve' } = {}
) {
  return new CodespaceController({
    client,
    store,
    repository: REPOSITORY,
    ref: REF,
    binding: BINDING,
    devcontainerPath: '.devcontainer/agor-managed/devcontainer.json',
    idleTimeoutMinutes: 30,
    retentionPeriodMinutes: 1440,
    appPort: 5000,
    healthPort: 3000,
    healthPath: '/health',
    portVisibility,
    waitSeconds: 30,
    sleep: async () => {},
    monotonic,
  });
}

test('start creates the exact repo/ref and persists a nonsecret binding', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient();
  const result = await controller(client, store).start();

  assert.equal(client.created, 1);
  assert.equal(result.resource.repository.full_name, REPOSITORY);
  assert.equal(result.resource.git_status.ref, REF);
  assert.deepEqual(new Set(result.ports.map((item) => item.sourcePort)), new Set([3000, 5000]));
  const state = await store.load();
  assert.equal(state.owner, 'octocat');
  assert.equal(state.name, result.resource.name);
  assert.equal(state.created_ref_sha, 'a'.repeat(40));
  assert.doesNotMatch(JSON.stringify(state), /token/i);
});

test('a second start rediscovers instead of creating a duplicate', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([resource()]);
  const instance = controller(client, store);
  await instance.start();
  await instance.start();
  assert.equal(client.created, 0);
});

test('Start repairs an already-Available Codespace whose Agor stack is unhealthy', async (t) => {
  const { store } = await fixture(t);
  const existing = resource();
  const client = new FakeClient([existing]);
  client.remoteHealthy = false;

  const result = await controller(client, store).start();

  assert.equal(result.resource.name, existing.name);
  assert.deepEqual(client.bootstrapCalls, [
    { name: existing.name, repository: REPOSITORY, options: { timeout: 30 } },
  ]);
  assert.deepEqual(client.events.slice(0, 3), ['health', 'bootstrap', 'health']);
});

test('Start does not launch a duplicate repair when a newly created Codespace is healthy', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient();

  await controller(client, store).start();

  assert.equal(client.created, 1);
  assert.deepEqual(client.bootstrapCalls, []);
});

test('a stopped Codespace is resumed and revalidated', async (t) => {
  const { store } = await fixture(t);
  const existing = resource({ state: 'Shutdown' });
  const client = new FakeClient([existing]);
  const result = await controller(client, store).start();
  assert.deepEqual(client.started, [existing.name]);
  assert.equal(result.resource.state, 'Available');
});

test('Sync applies one exact revision, waits for health, then re-attests it', async (t) => {
  const { store } = await fixture(t);
  const existing = resource();
  const client = new FakeClient([existing]);
  const revision = 'b'.repeat(40);

  const applied = await controller(client, store).sync(revision);

  assert.equal(applied, revision);
  assert.deepEqual(client.syncCalls, [
    {
      name: existing.name,
      repository: REPOSITORY,
      ref: REF,
      revision,
      options: { timeout: 30 },
    },
  ]);
  assert.deepEqual(client.verifyCalls, [
    { name: existing.name, repository: REPOSITORY, ref: REF, revision },
  ]);
  assert.deepEqual(client.events, ['sync', 'health', 'verify']);
});

test('Sync refuses to acknowledge a different post-readiness revision', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([resource()]);
  client.verifyWorkspaceRevision = async () => 'c'.repeat(40);

  await assert.rejects(controller(client, store).sync('b'.repeat(40)), /returned c+, expected b+/);
});

test('Sync refuses to wake or mutate a stopped Codespace', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([resource({ state: 'Shutdown' })]);

  await assert.rejects(controller(client, store).sync('b'.repeat(40)), /not available.*Shutdown/);
  assert.deepEqual(client.syncCalls, []);
  assert.deepEqual(client.started, []);
});

test('Start can make both preview ports public and reconcile a restart reset', async (t) => {
  const { store } = await fixture(t);
  const existing = resource();
  const client = new FakeClient([existing]);
  const instance = controller(client, store, { portVisibility: 'public' });

  const first = await instance.start();
  assert.deepEqual(client.visibilityCalls, [
    { name: existing.name, ports: [3000, 5000], visibility: 'public' },
  ]);
  assert.ok(first.ports.every((item) => item.visibility === 'public'));

  // GitHub resets public forwarded ports to private when a Codespace restarts.
  client.portVisibility = 'private';
  const second = await instance.start();
  assert.equal(client.created, 0);
  assert.equal(client.visibilityCalls.length, 2);
  assert.ok(second.ports.every((item) => item.visibility === 'public'));
});

test('a provider port-visibility policy failure is explicit and bounded', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([resource()]);
  client.setPortVisibility = async () => {
    throw new LauncherError('GitHub refused the visibility change');
  };

  await assert.rejects(
    controller(client, store, { portVisibility: 'public' }).start(),
    /organization Codespaces policy may prohibit.*GitHub refused/
  );
});

test('a recreated resource replaces a stale stored name after discovery', async (t) => {
  const { store } = await fixture(t);
  const oldResource = resource({ name: 'octocat-agor-old123' });
  await store.save({
    version: 1,
    binding: BINDING,
    repository: REPOSITORY,
    ref: REF,
    owner: 'octocat',
    name: oldResource.name,
    display_name: markerFor(REPOSITORY, BINDING),
  });
  const replacement = resource({ name: 'octocat-agor-new999' });
  const result = await controller(new FakeClient([replacement]), store).start();
  assert.equal(result.resource.name, replacement.name);
  assert.equal((await store.load()).name, replacement.name);
});

test('duplicate markers fail closed', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([
    resource({ name: 'octocat-agor-one111' }),
    resource({ name: 'octocat-agor-two222' }),
  ]);
  await assert.rejects(controller(client, store).start(), /ambiguous/);
  assert.equal(client.created, 0);
});

test('an actor change is blocked before remote mutation', async (t) => {
  const { store } = await fixture(t);
  const existing = resource();
  await store.save({
    version: 1,
    binding: BINDING,
    repository: REPOSITORY,
    ref: REF,
    owner: 'someone-else',
    name: existing.name,
    display_name: markerFor(REPOSITORY, BINDING),
  });
  const client = new FakeClient([existing]);
  await assert.rejects(controller(client, store).start(), /another GitHub actor/);
  assert.equal(client.created, 0);
});

test('stop and nuke are idempotent', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient();
  const instance = controller(client, store);
  assert.equal(await instance.stop(), undefined);
  assert.equal(await instance.nuke(), false);

  const existing = resource();
  client.resources.push(existing);
  assert.equal((await instance.stop()).state, 'Shutdown');
  assert.equal(await instance.nuke(), true);
  assert.deepEqual(client.deleted, [existing.name]);
  assert.equal(await store.load(), undefined);
});

test('destructive actions refetch and freeze on identity drift', async (t) => {
  const { store } = await fixture(t);
  const existing = resource();
  const client = new FakeClient([existing]);
  client.getCodespace = async () =>
    resource({ name: existing.name, marker: 'renamed-outside-agor' });
  await assert.rejects(controller(client, store).nuke(), /binding marker/);
  assert.deepEqual(client.deleted, []);
});

test('logs never wake a stopped Codespace', async (t) => {
  const { store } = await fixture(t);
  const existing = resource({ state: 'Shutdown' });
  const client = new FakeClient([existing]);
  const output = await controller(client, store).logs();
  assert.match(output, /GitHub CLI uses SSH and could resume the stopped Codespace/);
  assert.deepEqual(client.creationLogCalls, []);
  assert.deepEqual(client.runtimeLogCalls, []);
});

test('logs expose creation progress while the Codespace is starting', async (t) => {
  const { store } = await fixture(t);
  const existing = resource({ state: 'Starting' });
  const client = new FakeClient([existing]);
  const output = await controller(client, store).logs();
  assert.match(output, /--- Codespace creation log ---\nsafe creation log/);
  assert.match(output, /not available until the Codespace is Available.*Starting/);
  assert.deepEqual(client.creationLogCalls, [existing.name]);
  assert.deepEqual(client.runtimeLogCalls, []);
});

test('logs preserve creation diagnostics when runtime SSH is not ready', async (t) => {
  const { store } = await fixture(t);
  const existing = resource();
  const client = new FakeClient([existing]);
  client.runtimeLogs = async () => {
    throw new LauncherError('GitHub CLI command failed with ghp_abcdefghijklmnopqrstuvwxyz123456');
  };
  const output = await controller(client, store).logs();
  assert.match(output, /safe creation log/);
  assert.match(output, /Unavailable: GitHub CLI command failed/);
  assert.doesNotMatch(output, /ghp_/);
});

test('logs degrade safely while the creation-log SSH transport is not ready', async (t) => {
  const { store } = await fixture(t);
  const existing = resource({ state: 'Starting' });
  const client = new FakeClient([existing]);
  client.creationLogs = async () => {
    throw new LauncherError('SSH failed with ghp_abcdefghijklmnopqrstuvwxyz123456');
  };
  const output = await controller(client, store).logs();
  assert.match(output, /Codespace creation log ---\nUnavailable: SSH failed/);
  assert.match(output, /current state: Starting/);
  assert.doesNotMatch(output, /ghp_/);
  assert.deepEqual(client.runtimeLogCalls, []);
});

test('mismatched repo, ref, owner, or marker is never adopted', () => {
  for (const candidate of [
    resource({ owner: 'mallory' }),
    resource({ repository: 'another/repo' }),
    resource({ ref: 'another-branch' }),
    resource({ marker: 'not-this-branch' }),
  ]) {
    assert.throws(
      () =>
        validateResource(candidate, {
          owner: 'octocat',
          repository: REPOSITORY,
          repositoryId: 123,
          ref: REF,
          marker: markerFor(REPOSITORY, BINDING),
        }),
      LauncherError
    );
  }
});

test('the dynamic App URL comes from validated port metadata', () => {
  const existing = resource();
  assert.deepEqual(
    environmentResult(existing, ports(existing.name), {
      appPort: 5000,
      healthPort: 3000,
      healthPath: '/health',
      emitHealth: 'public-only',
    }),
    {
      version: 1,
      access_urls: [{ name: 'App', url: `https://${existing.name}-5000.app.github.dev` }],
      resource: {
        provider: 'github-codespaces',
        id: existing.name,
        name: existing.name,
        manage_url: `https://github.com/codespaces/${existing.name}`,
      },
    }
  );
  const badPorts = ports(existing.name);
  badPorts[1].browseUrl = 'https://evil.example.test/steal';
  assert.throws(
    () =>
      environmentResult(existing, badPorts, {
        appPort: 5000,
        healthPort: 3000,
        healthPath: '/health',
        emitHealth: 'public-only',
      }),
    /safe browse URL/
  );
});

test('health is emitted only under the selected visibility policy', () => {
  const existing = resource();
  const publicPorts = ports(existing.name);
  publicPorts[0].visibility = 'public';
  const result = environmentResult(existing, publicPorts, {
    appPort: 5000,
    healthPort: 3000,
    healthPath: '/ready',
    emitHealth: 'public-only',
  });
  assert.equal(result.health_url, `https://${existing.name}-3000.app.github.dev/ready`);
  assert.equal(
    environmentResult(existing, publicPorts, {
      appPort: 5000,
      healthPort: 3000,
      healthPath: '/ready',
      emitHealth: 'never',
    }).health_url,
    undefined
  );
});

test('Sync accepts only full lowercase SHA-1 or SHA-256 revisions', () => {
  const base = ['sync', '--repository', REPOSITORY, '--ref', REF, '--binding', BINDING];
  assert.equal(parseArgs([...base, '--revision', 'b'.repeat(40)]).revision, 'b'.repeat(40));
  assert.equal(parseArgs([...base, '--revision', 'c'.repeat(64)]).revision, 'c'.repeat(64));
  for (const revision of ['b'.repeat(39), 'B'.repeat(40), 'not-a-revision']) {
    assert.throws(() => parseArgs([...base, '--revision', revision]), /--revision/);
  }
  assert.throws(() => parseArgs(base), /--revision is required/);
  assert.throws(
    () =>
      parseArgs([
        'start',
        '--repository',
        REPOSITORY,
        '--ref',
        REF,
        '--binding',
        BINDING,
        '--revision',
        'b'.repeat(40),
      ]),
    /valid only for sync/
  );
});

test('health paths reject URLs, queries, and shell metacharacters', () => {
  const base = ['start', '--repository', REPOSITORY, '--ref', REF, '--binding', BINDING];
  for (const value of [
    'https://evil.test',
    '//evil.test/path',
    '/health?token=x',
    '/health; rm -rf /',
  ]) {
    assert.throws(() => parseArgs([...base, '--health-path', value]), /health-path/);
  }
});

test('port visibility is explicit and defaults to preserving provider state', () => {
  const base = ['start', '--repository', REPOSITORY, '--ref', REF, '--binding', BINDING];
  assert.equal(parseArgs(base).portVisibility, 'preserve');
  assert.equal(parseArgs([...base, '--port-visibility', 'public']).portVisibility, 'public');
  assert.throws(() => parseArgs([...base, '--port-visibility', 'internet']), /--port-visibility/);
});

test('refs preserve shell-looking text but reject control characters', () => {
  const base = ['start', '--repository', REPOSITORY, '--binding', BINDING, '--ref'];
  assert.equal(parseArgs([...base, "feature/quote'$(noop)"]).ref, "feature/quote'$(noop)");
  assert.throws(() => parseArgs([...base, 'feature/bad\nref']), /--ref/);
});

test('preview readiness has a bounded timeout', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([resource()]);
  client.listPorts = async () => [];
  const ticks = [0, 31, 62];
  await assert.rejects(
    controller(client, store, { monotonic: () => ticks.shift() }).start(),
    /timed out after 30s/
  );
});

test('preview readiness fails fast when the custom devcontainer has no SSH server', async (t) => {
  const { store } = await fixture(t);
  const client = new FakeClient([resource()]);
  client.remoteHealth = async () => {
    throw new LauncherError(
      'Codespaces SSH health probe failed: Please check if an SSH server is installed'
    );
  };
  let ticks = 0;
  await assert.rejects(
    controller(client, store, {
      monotonic: () => {
        ticks += 1;
        return 0;
      },
    }).start(),
    /built without the SSH transport.*rebuild its dev container or Nuke it/i
  );
  assert.ok(ticks < 3);
});

test('redaction removes common credentials and provider control lines', () => {
  const sanitized = redact(
    'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456 token=github_pat_abcdefghijklmnopqrstuvwxyz DATABASE_PASSWORD=hunter2\nAGOR_ENVIRONMENT_RESULT={"app":"https://evil.test"}'
  );
  assert.doesNotMatch(sanitized, /ghp_|github_pat_|hunter2|evil\.test/);
  assert.ok(sanitized.match(/\[REDACTED\]/g).length >= 3);
});

test('the gh adapter uses argv and JSON stdin for create', async () => {
  const calls = [];
  const runner = async (argv, options) => {
    calls.push({ argv: [...argv], ...options });
    return { returncode: 0, stdout: '{}', stderr: '' };
  };
  const client = new GitHubCodespacesClient({ runner, callTimeout: 17 });
  await client.createCodespace(
    REPOSITORY,
    "feature/quote'$(noop)",
    markerFor(REPOSITORY, BINDING),
    '.devcontainer/agor-managed/devcontainer.json',
    30,
    1440
  );
  assert.deepEqual(calls[0].argv.slice(0, 3), ['gh', 'api', '--method']);
  assert.doesNotMatch(calls[0].argv.join(' '), /feature\/quote/);
  assert.equal(JSON.parse(calls[0].inputText).ref, "feature/quote'$(noop)");
  assert.equal(calls[0].timeout, 17);
  assert.equal(calls[0].check, true);
});

test('the gh adapter explains that a missing remote ref must be pushed', async () => {
  const runner = async () => {
    throw new LauncherError(
      'GitHub CLI command failed with exit code 1: gh: No commit found for SHA: test2 (HTTP 422)'
    );
  };
  const client = new GitHubCodespacesClient({ runner });

  await assert.rejects(
    client.resolveRef(REPOSITORY, 'test2'),
    (error) =>
      error instanceof LauncherError &&
      error.message ===
        'GitHub cannot find ref "test2" in preset-io/agor. Push this branch or commit to GitHub before pressing Play; Codespaces cannot access an Agor-only local ref.'
  );
});

test('the gh adapter distinguishes an unhealthy app from a broken SSH transport', async () => {
  const calls = [];
  const results = [
    { returncode: 42, stdout: '', stderr: 'curl: connection refused' },
    {
      returncode: 1,
      stdout: '',
      stderr:
        'Please check if an SSH server is installed; token=ghp_abcdefghijklmnopqrstuvwxyz123456',
    },
  ];
  const runner = async (argv, options) => {
    calls.push({ argv, options });
    return results.shift();
  };
  const client = new GitHubCodespacesClient({ runner, callTimeout: 17 });

  assert.equal(await client.remoteHealth('octocat-agor-new123', 3000, '/health'), false);
  await assert.rejects(
    client.remoteHealth('octocat-agor-new123', 3000, '/health'),
    (error) =>
      error instanceof LauncherError &&
      /Codespaces SSH health probe failed with exit code 1.*SSH server is installed/.test(
        error.message
      ) &&
      !error.message.includes('ghp_')
  );
  assert.equal(calls[0].options.check, false);
  assert.equal(calls[0].options.timeout, 17);
  assert.match(calls[0].argv.at(-1), /exit 42/);
});

test('the gh adapter sends exact Sync logic over stdin with shell-quoted arguments', async () => {
  const calls = [];
  const revision = 'b'.repeat(40);
  const runner = async (argv, options) => {
    calls.push({ argv: [...argv], ...options });
    return {
      returncode: 0,
      stdout: options.inputText?.includes('actual_revision=$(git rev-parse HEAD)')
        ? `AGOR_CODESPACE_REVISION=${revision}\n`
        : '',
      stderr: '',
    };
  };
  const client = new GitHubCodespacesClient({ runner, callTimeout: 17 });
  const hostileLookingRef = "feature/quote'$(touch nope)";

  await client.syncWorkspace('octocat-agor-new123', REPOSITORY, hostileLookingRef, revision, {
    timeout: 99,
  });
  const applied = await client.verifyWorkspaceRevision(
    'octocat-agor-new123',
    REPOSITORY,
    hostileLookingRef,
    revision
  );

  assert.equal(applied, revision);
  assert.deepEqual(calls[0].argv.slice(0, 6), [
    'gh',
    'codespace',
    'ssh',
    '-c',
    'octocat-agor-new123',
    '--',
  ]);
  assert.match(calls[0].argv.at(-1), /feature\/quote'"'"'\$\(touch nope\)/);
  assert.match(calls[0].inputText, /checkout is dirty; refusing to overwrite developer work/);
  assert.match(calls[0].inputText, /merge-base --is-ancestor/);
  assert.match(calls[0].inputText, /docker compose -p agor-codespaces-sqlite down/);
  assert.match(calls[0].inputText, /AGOR_FORCE_REBUILD=true/);
  assert.equal(calls[0].timeout, 99);
  assert.equal(calls[1].timeout, 17);
});

test('the gh adapter rejects missing or ambiguous revision attestations', async () => {
  const revision = 'b'.repeat(40);
  const outputs = [
    '',
    `AGOR_CODESPACE_REVISION=${revision}\nAGOR_CODESPACE_REVISION=${revision}\n`,
  ];
  const client = new GitHubCodespacesClient({
    runner: async () => ({ returncode: 0, stdout: outputs.shift(), stderr: '' }),
  });

  await assert.rejects(
    client.verifyWorkspaceRevision('octocat-agor-new123', REPOSITORY, REF, revision),
    /invalid result/
  );
  await assert.rejects(
    client.verifyWorkspaceRevision('octocat-agor-new123', REPOSITORY, REF, revision),
    /invalid result/
  );
});

test('the gh adapter changes only the requested Codespace port visibility', async () => {
  const calls = [];
  const runner = async (argv, options) => {
    calls.push({ argv, options });
    return { returncode: 0, stdout: '', stderr: '' };
  };
  const client = new GitHubCodespacesClient({ runner, callTimeout: 17 });

  await client.setPortVisibility('octocat-agor-new123', [5000, 3000, 5000], 'public');

  assert.deepEqual(calls[0].argv, [
    'gh',
    'codespace',
    'ports',
    'visibility',
    '3000:public',
    '5000:public',
    '-c',
    'octocat-agor-new123',
  ]);
  assert.equal(calls[0].options.timeout, 17);
  assert.equal(calls[0].options.check, true);
});

test('the gh adapter exhausts paginated Codespace inventory', async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push([...argv]);
    return {
      returncode: 0,
      stdout: JSON.stringify([
        { codespaces: [resource({ name: 'octocat-agor-one111' })] },
        { codespaces: [resource({ name: 'octocat-agor-two222' })] },
      ]),
      stderr: '',
    };
  };
  const inventory = await new GitHubCodespacesClient({ runner }).listCodespaces(REPOSITORY);
  assert.equal(inventory.length, 2);
  assert.ok(calls[0].includes('--paginate'));
  assert.ok(calls[0].includes('--slurp'));
});

test('the local lock serializes concurrent lifecycle callbacks', async (t) => {
  const { store } = await fixture(t);
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  const first = store.withLock(async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  while (order.length === 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  const second = store.withLock(async () => {
    order.push('second');
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('the Codespaces bootstrap persists a non-default secret without logging it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-codespaces-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binDirectory = join(directory, 'bin');
  await mkdir(binDirectory);
  const fakeDocker = join(binDirectory, 'docker');
  await writeFile(
    fakeDocker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/docker-calls"
if [ "$*" != "compose -p agor-codespaces-sqlite ps" ]; then
  [ "\${AGOR_ADMIN_PASSWORD:-}" != "admin" ] || exit 91
  [ "\${AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN:-}" = "false" ] || exit 92
  [ "\${SEED:-}" = "false" ] || exit 93
  touch "$HOME/healthy"
fi
printf '%s\\n' 'fake docker ok'
`
  );
  await chmod(fakeDocker, 0o755);
  const fakeCurl = join(binDirectory, 'curl');
  await writeFile(fakeCurl, '#!/bin/sh\n[ -f "$HOME/healthy" ]\n');
  await chmod(fakeCurl, 0o755);
  const script = join(process.cwd(), '.devcontainer/agor-managed/start-agor-sqlite.sh');
  const env = {
    ...process.env,
    HOME: directory,
    PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
    CODESPACE_NAME: 'agor-cs-test123',
    GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev',
  };

  const first = await execFileAsync('bash', [script], { env });
  const passwordPath = join(directory, '.agor-managed/bootstrap-admin-password');
  const password = (await readFile(passwordPath, 'utf8')).trim();
  assert.match(password, /^[a-f0-9]{48}$/);
  assert.notEqual(password, 'admin');
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, new RegExp(password));
  assert.doesNotMatch(`${first.stdout}${first.stderr}`, /SEED=true/);

  const second = await execFileAsync('bash', [script], { env });
  assert.equal((await readFile(passwordPath, 'utf8')).trim(), password);
  assert.match(second.stdout, /already healthy; skipping rebuild/);
  let dockerCalls = await readFile(join(directory, 'docker-calls'), 'utf8');
  assert.equal(dockerCalls.match(/up -d --build/g)?.length, 1);

  await execFileAsync('bash', [script], {
    env: { ...env, AGOR_FORCE_REBUILD: 'true' },
  });
  dockerCalls = await readFile(join(directory, 'docker-calls'), 'utf8');
  assert.equal(dockerCalls.match(/up -d --build/g)?.length, 2);
});
