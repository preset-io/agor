import assert from 'node:assert/strict';
import test from 'node:test';
import { resetVolume, volumeState } from './volume-reset.mjs';

const old = '11111111-1111-1111-1111-111111111111';
const fresh = '22222222-2222-2222-2222-222222222222';
const target = {
  binding: 'branch-a',
  volumeId: old,
  projectId: 'project-a',
  environmentId: 'env-a',
  serviceId: 'service-a',
};
function fixture({ shared = false, createError = false } = {}) {
  const calls = [];
  let state = { phase: 'ready', volumeId: old };
  const preview = {
    target,
    async inspect() {
      if (state.phase !== 'ready') throw new Error('Interrupted');
      return { volumeId: state.volumeId, state };
    },
    async stop() {
      calls.push('stop');
    },
    async setVariables() {
      calls.push('variables');
    },
    async setVolumeState(value) {
      state = structuredClone(value);
      calls.push(value.phase);
    },
  };
  const admin = {
    async query(q) {
      if (q.includes('query Volumes'))
        return {
          project: {
            volumes: {
              edges: [
                {
                  node: {
                    id: old,
                    volumeInstances: {
                      edges: [
                        { node: { environmentId: 'env-a', serviceId: 'service-a' } },
                        ...(shared
                          ? [{ node: { environmentId: 'foreign', serviceId: 'foreign' } }]
                          : []),
                      ],
                    },
                  },
                },
              ],
            },
          },
        };
      if (q.includes('DeleteVolume')) {
        calls.push('delete');
        return { volumeDelete: true };
      }
      if (q.includes('CreateVolume')) {
        calls.push('create');
        if (createError) throw new Error('Unknown outcome');
        return { volumeCreate: { id: fresh } };
      }
      throw new Error('Unexpected request');
    },
  };
  return { preview, admin, calls, state: () => state };
}

test('Nuke persists intent before delete/create, binds new volume and drains automatic deployments', async () => {
  const f = fixture();
  await resetVolume(f.preview, f.admin);
  assert.deepEqual(f.calls, [
    'stop',
    'variables',
    'deleting',
    'delete',
    'creating',
    'create',
    'ready',
    'stop',
  ]);
  assert.equal(volumeState(JSON.stringify(f.state()), target).volumeId, fresh);
});

test('missing operator credential or cross-environment shared volume has no side effects', async () => {
  for (const shared of [true, false]) {
    const f = fixture({ shared });
    await assert.rejects(resetVolume(f.preview, shared ? f.admin : null));
    assert.deepEqual(f.calls, []);
  }
  for (const change of [{ binding: 'foreign' }, { seedVolumeId: fresh }, { volumeId: 'invalid' }]) {
    assert.throws(() =>
      volumeState(
        JSON.stringify({
          version: 1,
          binding: target.binding,
          seedVolumeId: old,
          phase: 'ready',
          volumeId: old,
          ...change,
        }),
        target
      )
    );
  }
});

test('unknown create outcome stays fenced and a repeat cannot create twice', async () => {
  const f = fixture({ createError: true });
  await assert.rejects(resetVolume(f.preview, f.admin));
  assert.equal(f.state().phase, 'creating');
  await assert.rejects(resetVolume(f.preview, f.admin));
  assert.equal(f.calls.filter((c) => c === 'create').length, 1);
});
