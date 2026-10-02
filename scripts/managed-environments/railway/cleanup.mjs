import { setTimeout as delay } from 'node:timers/promises';
import { nodes, requireValue, uuid } from './api.mjs';
import { CLEANUP_MARKER, MARKER } from './configuration.mjs';

const sharedKeys = new Set([
  CLEANUP_MARKER,
  'RAILWAY_PROJECT_ID',
  'RAILWAY_PROJECT_NAME',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME',
]);
const phases = ['service', 'volume', 'environment'];
const pendingMessage = (phase) =>
  `${phase} deletion is not yet visible. Wait, then repeat Nuke; the cleanup receipt is retained. No deletion was retried.`;

// Only read back after a mutation. Never treat a successful API response alone
// as deletion, and never repeat a mutation whose outcome is ambiguous.
async function waitFor(read, phase) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await read()) return;
    if (attempt < 14) await delay(1000);
  }
  requireValue(false, pendingMessage(phase));
}

function validateReceipt(preview, environment, receipt) {
  requireValue(
    receipt?.schema === 1 &&
      receipt.environmentId === environment.id &&
      environment.name === preview.name &&
      Object.entries(preview.owner).every(([key, value]) => receipt.owner?.[key] === value) &&
      (preview.owner.version === 1 || receipt.owner?.tenantId === undefined) &&
      ['serviceId', 'volumeId', 'volumeInstanceId'].every((key) => uuid(receipt[key])) &&
      phases.every((phase) => typeof receipt.requested?.[phase] === 'boolean'),
    'Foreign or invalid cleanup receipt; refusing deletion.'
  );
}

export async function readCleanup(preview) {
  const all = await preview.inventory();
  const matches = all.environments.filter((e) => e.name === preview.name);
  requireValue(matches.length <= 1, 'Duplicate Railway environment identity; inspect manually.');
  if (!matches.length) return null;
  const environment = matches[0];
  const shared = await preview.variables({
    projectId: preview.config.projectId,
    environmentId: environment.id,
  });
  if (!Object.hasOwn(shared, CLEANUP_MARKER)) return null;
  requireValue(
    Object.keys(shared).every((key) => sharedKeys.has(key)),
    'Cleanup environment has unrelated shared variables; refusing deletion.'
  );
  let receipt;
  try {
    receipt = JSON.parse(shared[CLEANUP_MARKER]);
  } catch {
    /* Never echo provider variables. */
  }
  validateReceipt(preview, environment, receipt);
  return receipt;
}

async function save(preview, receipt) {
  const result = await preview.api.query(
    'mutation PreviewCleanupReceipt($input:VariableUpsertInput!){variableUpsert(input:$input)}',
    {
      input: {
        projectId: preview.config.projectId,
        environmentId: receipt.environmentId,
        name: CLEANUP_MARKER,
        value: JSON.stringify(receipt),
        skipDeploys: true,
      },
    }
  );
  requireValue(
    result.variableUpsert === true,
    'Cleanup receipt was not confirmed; inspect before retrying.'
  );
}

// Revalidate exact IDs and all attachments, including foreign resources added
// during a partial cleanup. A deterministic environment name alone is not proof.
async function snapshot(preview, receipt) {
  const all = await preview.inventory();
  const environment = all.environments.find((e) => e.id === receipt.environmentId);
  requireValue(
    (!environment || environment.name === preview.name) &&
      !all.environments.some((e) => e.name === preview.name && e.id !== receipt.environmentId),
    'Cleanup environment was replaced; refusing deletion.'
  );
  const service = all.services.find((s) => s.id === receipt.serviceId);
  requireValue(
    !all.services.some(
      (s) =>
        s.id !== receipt.serviceId &&
        (s.name === preview.name ||
          nodes(s.serviceInstances).some((i) => i.environmentId === receipt.environmentId))
    ),
    'Cleanup environment contains a foreign service; refusing deletion.'
  );
  if (service) {
    const instances = nodes(service.serviceInstances);
    requireValue(
      environment &&
        service.name === preview.name &&
        instances.length === 1 &&
        instances[0].serviceId === service.id &&
        instances[0].environmentId === environment.id,
      'Cleanup service changed or is shared; refusing deletion.'
    );
    const vars = await preview.variables({
      projectId: preview.config.projectId,
      environmentId: environment.id,
      serviceId: service.id,
    });
    let record;
    try {
      record = JSON.parse(vars[MARKER]);
    } catch {
      /* Never echo variables. */
    }
    requireValue(
      Object.entries(preview.owner).every(([key, value]) => record?.[key] === value) &&
        record.environmentId === environment.id &&
        record.serviceId === service.id &&
        record.volumeId === receipt.volumeId,
      'Cleanup service ownership changed; refusing deletion.'
    );
  }
  requireValue(
    !all.volumes.some(
      (v) =>
        v.id !== receipt.volumeId &&
        nodes(v.volumeInstances).some(
          (i) => i.environmentId === receipt.environmentId || i.serviceId === receipt.serviceId
        )
    ),
    'Cleanup environment contains a foreign volume; refusing deletion.'
  );
  const volume = all.volumes.find((v) => v.id === receipt.volumeId);
  if (volume) {
    const instances = nodes(volume.volumeInstances);
    requireValue(
      instances.length === 1 &&
        instances[0].id === receipt.volumeInstanceId &&
        instances[0].environmentId === receipt.environmentId &&
        instances[0].mountPath === '/home/agor/.agor' &&
        (instances[0].serviceId === null || (service && instances[0].serviceId === service.id)),
      'Cleanup volume was replaced or reattached; refusing deletion.'
    );
  }
  return { environment, service, volume };
}

async function volumeGone(preview, receipt, state) {
  if (!state.volume) return true;
  const { volumeInstance: i } = await preview.api.query(
    'query PreviewDeletedVolume($id:String!){volumeInstance(id:$id){id volumeId serviceId environmentId isPendingDeletion deletedAt}}',
    { id: receipt.volumeInstanceId }
  );
  requireValue(
    i?.id === receipt.volumeInstanceId &&
      i.volumeId === receipt.volumeId &&
      i.environmentId === receipt.environmentId &&
      i.serviceId === null,
    'Cleanup volume identity changed; refusing deletion.'
  );
  return (
    i.isPendingDeletion === true &&
    typeof i.deletedAt === 'string' &&
    Number.isFinite(Date.parse(i.deletedAt))
  );
}

export async function removePreview(preview, owned, receipt = null) {
  if (!receipt) {
    requireValue(
      owned.record?.ready && owned.service && owned.volume && owned.domain,
      'Refusing destructive cleanup of an incomplete preview; inspect manually.'
    );
    requireValue(
      (await preview.active(owned)).length === 0,
      'Compute must be stopped before removal.'
    );
    receipt = {
      schema: 1,
      owner: preview.owner,
      environmentId: owned.environment.id,
      serviceId: owned.service.id,
      volumeId: owned.volume.id,
      volumeInstanceId: nodes(owned.volume.volumeInstances)[0].id,
      requested: { service: false, volume: false, environment: false },
    };
    await save(preview, receipt);
  }
  const mutations = {
    service: 'mutation PreviewDeleteService($id:String!){serviceDelete(id:$id)}',
    volume: 'mutation PreviewDeleteVolume($id:String!){volumeDelete(volumeId:$id)}',
    environment: 'mutation PreviewDeleteEnvironment($id:String!){environmentDelete(id:$id)}',
  };
  for (const phase of phases) {
    let state = await snapshot(preview, receipt);
    if (phase !== 'service')
      requireValue(
        !state.service,
        'Service deletion is still pending; repeat Nuke after it settles.'
      );
    const gone = (s) => (phase === 'volume' ? volumeGone(preview, receipt, s) : !s[phase]);
    if (await gone(state)) continue;
    requireValue(
      state.environment,
      'Cleanup environment disappeared with resources remaining; inspect manually.'
    );
    if (!receipt.requested[phase]) {
      if (phase === 'service') {
        requireValue(
          (await preview.active(state)).length === 0,
          'Compute must be stopped before removal.'
        );
      }
      receipt.requested[phase] = true;
      await save(preview, receipt);
      // Recheck for newly attached/foreign resources immediately before mutation.
      state = await snapshot(preview, receipt);
      if (phase === 'environment') {
        requireValue(
          !state.service && (await volumeGone(preview, receipt, state)),
          'Environment is no longer empty; refusing deletion.'
        );
      }
      if (!(await gone(state))) {
        const result = await preview.api.query(mutations[phase], { id: receipt[`${phase}Id`] });
        requireValue(
          result[`${phase}Delete`] === true,
          `${phase} deletion not confirmed; inspect before retrying.`
        );
      }
    }
    await waitFor(async () => gone(await snapshot(preview, receipt)), phase);
  }
}
