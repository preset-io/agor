import { randomUUID } from 'node:crypto';

export const VOLUME_STATE_VARIABLE = 'AGOR_MANAGED_VOLUME_STATE';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

// Provider-side state is scoped by the project token + checked branch/source
// marker. Never adopt an arbitrary attached volume merely because it exists.
export function volumeState(raw, target) {
  if (!raw) return { phase: 'ready', volumeId: target.volumeId };
  const state = JSON.parse(raw);
  if (
    state.version !== 1 ||
    state.binding !== target.binding ||
    state.seedVolumeId !== target.volumeId ||
    !UUID.test(state.volumeId ?? '') ||
    !['ready', 'deleting', 'creating'].includes(state.phase)
  )
    throw new Error('Invalid remote volume ownership state');
  return state;
}

export async function resetVolume(preview, admin) {
  // Missing admin credentials must fail before stopping anything.
  if (!admin) throw new Error('Nuke requires RAILWAY_API_TOKEN (workspace access)');
  const { volumeId, state } = await preview.inspect();
  if (state.phase !== 'ready')
    throw new Error('Interrupted reset requires operator reconciliation');
  const t = preview.target;
  const inventory = await admin.query(
    'query Volumes($id:String!){project(id:$id){volumes{edges{node{id volumeInstances{edges{node{environmentId serviceId}}}}}}}}',
    { id: t.projectId }
  );
  const instances = inventory.project.volumes.edges
    .find(({ node }) => node.id === volumeId)
    ?.node.volumeInstances.edges.map(({ node }) => node);
  if (
    instances?.length !== 1 ||
    instances[0].environmentId !== t.environmentId ||
    instances[0].serviceId !== t.serviceId
  )
    throw new Error('Refusing to delete a shared/foreign volume');
  await preview.stop();
  await preview.setVariables();
  const record = {
    version: 1,
    binding: t.binding,
    seedVolumeId: t.volumeId,
    volumeId,
    resetId: randomUUID(),
    phase: 'deleting',
  };
  // Write intent before irreversible mutations. Unknown outcomes remain fenced:
  // subsequent Play/Nuke must not blindly delete or create again.
  await preview.setVolumeState(record);
  const deleted = await admin.query(
    'mutation DeleteVolume($id:String!){volumeDelete(volumeId:$id)}',
    {
      id: volumeId,
    }
  );
  if (deleted.volumeDelete !== true) throw new Error('Unconfirmed volume deletion');
  record.phase = 'creating';
  await preview.setVolumeState(record);
  const { volumeCreate } = await admin.query(
    'mutation CreateVolume($input:VolumeCreateInput!){volumeCreate(input:$input){id}}',
    {
      input: {
        projectId: t.projectId,
        environmentId: t.environmentId,
        serviceId: t.serviceId,
        mountPath: '/home/agor/.agor',
        region: 'sfo',
      },
    }
  );
  if (!UUID.test(volumeCreate?.id ?? '')) throw new Error('Unconfirmed new volume ID');
  await preview.setVolumeState({ ...record, volumeId: volumeCreate.id, phase: 'ready' });
  // Railway may deploy automatically when attaching a volume. Nuke must leave
  // no compute running, not silently create a billable replacement deployment.
  await preview.stop();
  await preview.inspect();
}
