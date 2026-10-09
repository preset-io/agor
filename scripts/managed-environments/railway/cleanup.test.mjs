import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CLEANUP_MARKER } from './configuration.mjs';
import { conn, fixture } from './test-fixture.mjs';

test('Nuke waits for delayed volume visibility without repeating deletion', async () => {
  const f = fixture();
  await f.action('start');
  f.state.softDelete = 'delayed';
  await f.action('nuke');
  assert.equal(f.state.environments.length, 0);
  assert.equal(f.mutations().filter((c) => c.q.includes('PreviewDeleteVolume(')).length, 1);
});

for (const operation of [
  'PreviewCleanupReceipt',
  'PreviewDeleteService',
  'PreviewDeleteVolume',
  'PreviewDeleteEnvironment',
]) {
  test(`Nuke resumes after lost ${operation} response without repeating deletion`, async () => {
    const f = fixture();
    await f.action('start');
    f.state.softDelete = 'confirmed';
    f.state.fail = operation;
    await assert.rejects(f.action('nuke'), /No mutation was retried/);
    await f.action('nuke');
    assert.equal(f.state.environments.length, 0);
    assert.equal(f.state.services.length, 0);
    for (const action of ['Service', 'Volume', 'Environment']) {
      assert.equal(f.mutations().filter((c) => c.q.includes(`PreviewDelete${action}(`)).length, 1);
    }
  });
}

for (const key of ['tenantId', 'workspaceId', 'projectId', 'repository', 'branchId', 'ref']) {
  test(`cleanup receipt with another ${key} never authorizes deletion`, async () => {
    const f = fixture();
    await f.action('start');
    f.state.fail = 'PreviewDeleteService';
    await assert.rejects(f.action('nuke'));
    const receipt = JSON.parse(f.state.shared[CLEANUP_MARKER]);
    receipt.owner[key] = randomUUID();
    f.state.shared[CLEANUP_MARKER] = JSON.stringify(receipt);
    const before = f.mutations().length;
    await assert.rejects(f.action('nuke'), /Foreign or invalid cleanup receipt/);
    assert.equal(f.mutations().length, before);
  });
}

test('partial cleanup blocks Start and does not silently recreate deleted data', async () => {
  const f = fixture();
  await f.action('start');
  f.state.fail = 'PreviewDeleteService';
  await assert.rejects(f.action('nuke'));
  const before = f.mutations().length;
  await assert.rejects(f.action('start'), /cleanup is incomplete/);
  assert.equal(f.mutations().length, before);
});

for (const kind of ['service', 'volume', 'shared variable', 'volume instance', 'environment']) {
  test(`Nuke refuses ${kind} replacement during partial cleanup`, async () => {
    const f = fixture();
    await f.action('start');
    f.state.fail = 'PreviewDeleteService';
    await assert.rejects(f.action('nuke'));
    const environment = f.state.environments[0];
    if (kind === 'service')
      f.state.services.push({
        id: randomUUID(),
        name: 'foreign',
        serviceInstances: conn([{ id: randomUUID(), environmentId: environment.id }]),
      });
    if (kind === 'volume')
      f.state.volumes.push({
        id: randomUUID(),
        volumeInstances: conn([{ id: randomUUID(), environmentId: environment.id }]),
      });
    if (kind === 'shared variable') f.state.shared.UNRELATED = 'do-not-inherit';
    if (kind === 'volume instance')
      f.state.volumes[0].volumeInstances.edges[0].node.id = randomUUID();
    if (kind === 'environment') environment.id = randomUUID();
    const before = f.mutations().length;
    await assert.rejects(f.action('nuke'), /foreign|unrelated|replaced|invalid cleanup receipt/);
    assert.equal(f.mutations().length, before);
  });
}

test('a missing service without a cleanup receipt cannot claim an orphaned volume', async () => {
  const f = fixture();
  await f.action('start');
  f.state.services = [];
  f.state.volumes[0].volumeInstances.edges[0].node.serviceId = null;
  const before = f.mutations().length;
  await assert.rejects(f.action('nuke'), /orphaned/);
  assert.equal(f.mutations().length, before);
});

test('cleanup receipt contains identifiers, not app/controller credentials', async () => {
  const f = fixture();
  await f.action('start');
  f.state.fail = 'PreviewDeleteService';
  await assert.rejects(f.action('nuke'));
  const receipt = f.state.shared[CLEANUP_MARKER];
  assert.ok(receipt);
  assert.ok(!receipt.includes(f.env.RAILWAY_API_TOKEN));
  assert.ok(!receipt.includes(f.env.RAILWAY_AGOR_ADMIN_PASSWORD));
});

test('an unknown deletion outcome is observed, never blindly resubmitted', async () => {
  const f = fixture();
  await f.action('start');
  f.state.failBefore = 'PreviewDeleteVolume';
  await assert.rejects(f.action('nuke'), /No mutation was retried/);
  await assert.rejects(f.action('nuke'), /not yet visible/);
  assert.equal(f.mutations().filter((c) => c.q.includes('PreviewDeleteVolume(')).length, 1);
  assert.equal(f.state.environments.length, 1);
  assert.equal(f.state.volumes.length, 1);
});
