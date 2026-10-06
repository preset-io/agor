import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEANUP_MARKER, identity, MARKER, resourceName } from './configuration.mjs';
import { run } from './launcher.mjs';
import { fixture } from './test-fixture.mjs';

test('docs variant scopes every lifecycle command and is accepted by the plain Node CLI', () => {
  const yaml = readFileSync(new URL('../../../.agor.yml', import.meta.url), 'utf8');
  const docs = yaml.split('    railway-docs:')[1].split('    codespaces-sqlite:')[0];
  assert.match(docs, /extends: railway-sqlite/);
  for (const action of ['start', 'stop', 'logs', 'nuke'])
    assert.ok(docs.includes(`launcher.mjs ${action} --profile docs`));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('./launcher.mjs', import.meta.url)), 'check', '--profile', 'docs'],
        { env: {}, stdio: 'pipe' }
      ),
    (error) => error.status === 1 && /Opt in/.test(String(error.stderr))
  );
});

test('docs starts without a password or app base image; lifecycle retains/removes only its cache', async () => {
  const f = fixture();
  f.input.profile = 'docs';
  delete f.env.RAILWAY_AGOR_ADMIN_PASSWORD;
  delete f.env.RAILWAY_PREVIEW_CONFIG;
  f.env.RAILWAY_AGOR_PROJECT_ID = f.config.projectId;
  assert.deepEqual(await f.action('start'), {
    app: 'https://test.up.railway.app/',
    health: 'https://test.up.railway.app/',
  });
  assert.equal(f.state.registryCalls, undefined);
  assert.equal(f.state.settings.dockerfilePath, 'docker/Dockerfile.docs-preview');
  assert.equal(f.state.settings.healthcheckPath, '/');
  assert.equal(f.state.vars.NEXT_PUBLIC_SITE_URL, 'https://test.up.railway.app');
  assert.equal(f.state.vars.AGOR_SOURCE_BRANCH, 'feature');
  for (const key of [
    'AGOR_ADMIN_PASSWORD',
    'RAILWAY_API_TOKEN',
    'AGOR_RUNTIME_TARGET',
    'AGOR_AGENTIC_TOOLS',
  ])
    assert.equal(f.state.vars[key], undefined);
  const volume = f.state.volumes[0].id;
  const before = f.mutations().length;
  await f.action('start');
  assert.equal(f.mutations().length, before);
  await f.action('stop');
  assert.equal(f.state.volumes[0].id, volume);
  await f.action('start');
  assert.equal(f.state.volumes[0].id, volume);
  await f.action('nuke');
  assert.equal(f.state.environments.length, 0);
  assert.equal(f.state.services.length, 0);
  assert.equal(f.state.volumes.length, 0);
});

test('docs requires a pushed ref before any provisioning and rejects unknown profiles before network', async () => {
  const f = fixture();
  f.input.profile = 'docs';
  f.state.missing = true;
  await assert.rejects(f.action('start'), /Push it/);
  assert.equal(f.mutations().length, 0);
  await assert.rejects(
    run('start', { ...f.input, profile: 'unknown' }, f.env, () =>
      assert.fail('unexpected network')
    ),
    /profile/
  );
});

test('docs has separate identity without renaming existing SQLite previews', () => {
  const f = fixture();
  for (const sharedProject of [false, true]) {
    const config = { ...f.config, sharedProject };
    const sqlite = identity(config, f.input);
    assert.equal(sqlite.profile, undefined);
    const previous = `agor-${createHash('sha256')
      .update(
        JSON.stringify([
          sqlite.tenantId,
          sqlite.workspaceId,
          sqlite.projectId,
          sqlite.repository,
          sqlite.branchId,
        ])
      )
      .digest('hex')
      .slice(0, sharedProject ? 20 : 32)}`;
    assert.equal(resourceName(sqlite), previous);
    assert.equal(resourceName(identity(config, { ...f.input, profile: 'sqlite' })), previous);
    assert.notEqual(resourceName(identity(config, { ...f.input, profile: 'docs' })), previous);
  }
});

test('SQLite lifecycle ignores a docs preview in a shared project', async () => {
  const f = fixture();
  delete f.env.RAILWAY_PREVIEW_CONFIG;
  f.env.RAILWAY_AGOR_PROJECT_ID = f.config.projectId;
  f.input.profile = 'docs';
  await f.action('start');
  const before = f.mutations().length;
  f.input.profile = 'sqlite';
  for (const action of ['check', 'stop', 'nuke']) await f.action(action);
  assert.equal(f.mutations().length, before);
  assert.equal(f.state.services.length, 1);
});

for (const key of [
  'tenantId',
  'projectId',
  'workspaceId',
  'branchId',
  'ref',
  'profile',
  'volumeId',
]) {
  test(`docs rejects foreign ${key} before lifecycle mutations`, async () => {
    const f = fixture();
    f.input.profile = 'docs';
    await f.action('start');
    const record = JSON.parse(f.state.vars[MARKER]);
    record[key] = randomUUID();
    f.state.vars[MARKER] = JSON.stringify(record);
    const before = f.mutations().length;
    for (const action of ['start', 'stop', 'nuke']) await assert.rejects(f.action(action));
    assert.equal(f.mutations().length, before);
  });
}

test('partial docs cleanup rejects swapped profile and resumes its own receipt', async () => {
  const f = fixture();
  f.input.profile = 'docs';
  await f.action('start');
  f.state.fail = 'PreviewDeleteService';
  await assert.rejects(f.action('nuke'));
  const saved = f.state.shared[CLEANUP_MARKER];
  const record = JSON.parse(saved);
  delete record.owner.profile;
  f.state.shared[CLEANUP_MARKER] = JSON.stringify(record);
  const before = f.mutations().length;
  await assert.rejects(f.action('nuke'), /Foreign or invalid cleanup receipt/);
  assert.equal(f.mutations().length, before);
  f.state.shared[CLEANUP_MARKER] = saved;
  await f.action('nuke');
  assert.equal(f.state.environments.length, 0);
});
