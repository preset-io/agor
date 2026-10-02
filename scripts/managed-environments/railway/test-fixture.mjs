import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { run } from './launcher.mjs';

export const conn = (values) => ({
  edges: values.map((node) => ({ node })),
  pageInfo: { hasNextPage: false },
});
export function fixture() {
  const config = {
    enabled: true,
    tenantId: 'tenant-a',
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    repository: 'preset-io/agor',
    maxPreviews: 3,
  };
  const env = {
    RAILWAY_PREVIEW_CONFIG: JSON.stringify(config),
    RAILWAY_API_TOKEN: 'secret-controller-token',
    RAILWAY_AGOR_ADMIN_PASSWORD: 'synthetic-password',
  };
  const input = { binding: randomUUID(), repository: config.repository, ref: 'feature' };
  const state = {
    environments: [],
    services: [],
    volumes: [],
    domains: [],
    deployments: [],
    vars: {},
    settings: {},
    limits: {},
    shared: {},
    calls: [],
    fail: undefined,
    missing: false,
  };
  const request = async (url, options) => {
    if (String(url).startsWith('https://auth.docker.io/'))
      return Response.json({ token: 'anonymous-pull-token' });
    if (String(url).startsWith('https://registry-1.docker.io/')) {
      state.registryCalls = (state.registryCalls ?? 0) + 1;
      return new Response(null, {
        status: state.registryStatus ?? (state.previewDigest ? 200 : 404),
        headers: state.previewDigest ? { 'docker-content-digest': state.previewDigest } : {},
      });
    }
    if (String(url).startsWith('https://api.github.com/')) {
      assert.equal(options.headers, undefined);
      return new Response(
        JSON.stringify({
          ref: 'refs/heads/feature',
          object: { type: 'commit', sha: 'a'.repeat(40) },
        }),
        { status: state.missing ? 404 : 200 }
      );
    }
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(options.redirect, 'error');
    const { query: q, variables: v } = JSON.parse(options.body);
    state.calls.push({ q, v });
    if (state.failBefore && q.includes(`${state.failBefore}(`)) {
      state.failBefore = undefined;
      throw new Error('lost-request-secret');
    }
    const i = v.input;
    let data;
    if (q.includes('PreviewInventory'))
      data = {
        project: {
          id: config.projectId,
          workspaceId: config.workspaceId,
          environments: conn(state.environments),
          services: conn(state.services),
          volumes: conn(state.volumes),
        },
      };
    else if (q.includes('PreviewProject('))
      data = { project: { id: config.projectId, workspaceId: config.workspaceId } };
    else if (q.includes('PreviewVariables('))
      data = { variables: v.serviceId ? state.vars : state.shared };
    else if (q.includes('PreviewDetails'))
      data = {
        domains: { serviceDomains: state.domains },
        serviceInstance: state.settings,
        environment: { deploymentTriggers: conn([]) },
      };
    else if (q.includes('PreviewEnvironment')) {
      assert.equal(i.sourceEnvironmentId, undefined);
      const e = { id: randomUUID(), name: i.name };
      state.environments.push(e);
      data = { environmentCreate: e };
    } else if (q.includes('PreviewServiceRow(')) {
      assert.equal(i.environmentId, undefined);
      assert.equal(i.source, undefined);
      const id = randomUUID();
      state.services.push({
        id,
        name: i.name,
        serviceInstances: conn(
          state.environments
            .filter((e) => e.name === 'production')
            .map((e) => ({ id: randomUUID(), serviceId: id, environmentId: e.id }))
        ),
      });
      data = { serviceCreate: { id } };
    } else if (q.includes('PreviewEmptyInstance(')) {
      data = { serviceInstance: { source: null }, deployments: conn([]) };
    } else if (q.includes('PreviewRemoveEmptyFanout(')) {
      const id = Object.keys(v.patch.services)[0];
      const row = state.services.find((s) => s.id === id);
      row.serviceInstances.edges = row.serviceInstances.edges.filter(
        (e) => e.node.environmentId !== v.environmentId
      );
      data = { environmentPatchCommit: 'confirmed' };
    } else if (q.includes('PreviewService(')) {
      const [id, settings] = Object.entries(v.patch.services)[0];
      assert.equal(settings.source, undefined);
      state.vars = Object.fromEntries(
        Object.entries(settings.variables).map(([key, value]) => [key, value.value])
      );
      const row = state.services.find((s) => s.id === id);
      assert.ok(row, 'patch must reference a real service ID, never a name');
      row.serviceInstances = conn([
        { id: randomUUID(), serviceId: id, environmentId: v.environmentId },
      ]);
      data = { environmentPatchCommit: 'confirmed' };
    } else if (q.includes('PreviewCleanupReceipt')) {
      assert.equal(i.serviceId, undefined);
      assert.equal(i.skipDeploys, true);
      state.shared[i.name] = i.value;
      data = { variableUpsert: true };
    } else if (q.includes('PreviewMarker')) {
      state.vars[i.name] = i.value;
      data = { variableUpsert: true };
    } else if (q.includes('PreviewVolume')) {
      const volume = {
        id: randomUUID(),
        volumeInstances: conn([
          {
            id: randomUUID(),
            serviceId: i.serviceId,
            environmentId: i.environmentId,
            mountPath: i.mountPath,
          },
        ]),
      };
      state.volumes.push(volume);
      data = { volumeCreate: volume };
    } else if (q.includes('PreviewDomain')) {
      const domain = { domain: 'test.up.railway.app', targetPort: 3030 };
      state.domains.push(domain);
      data = { serviceDomainCreate: domain };
    } else if (q.includes('PreviewVariablesSet')) {
      state.vars = i.variables;
      data = { variableCollectionUpsert: true };
    } else if (q.includes('PreviewLimits')) data = { serviceInstanceLimits: state.limits };
    else if (q.includes('PreviewLimitSet')) {
      state.limits = i;
      data = { serviceInstanceLimitsUpdate: true };
    } else if (q.includes('PreviewSettings')) {
      assert.equal(i.builder, undefined, 'DOCKERFILE is not a live Builder enum value');
      state.settings = i;
      data = { serviceInstanceUpdate: true };
    } else if (q.includes('PreviewDeployments')) data = { deployments: conn(state.deployments) };
    else if (q.includes('PreviewDeploy(')) {
      assert.equal(v.commitSha, 'a'.repeat(40));
      const d = { id: randomUUID(), status: 'SUCCESS' };
      state.deployments.push(d);
      data = { serviceInstanceDeployV2: d.id };
    } else if (q.includes('PreviewStop')) {
      state.deployments.forEach((d) => {
        d.status = 'REMOVED';
      });
      data = { deploymentRemove: true, deploymentCancel: true };
    } else if (q.includes('PreviewDeleteService')) {
      state.services = state.services.filter((s) => s.id !== v.id);
      state.volumes.forEach((volume) => {
        for (const edge of volume.volumeInstances.edges) {
          if (edge.node.serviceId === v.id) edge.node.serviceId = null;
        }
      });
      state.afterServiceDelete?.();
      state.vars = {};
      data = { serviceDelete: true };
    } else if (q.includes('PreviewDeleteVolume')) {
      state.volumeDeletionRequested = true;
      if (!state.softDelete) state.volumes = state.volumes.filter((volume) => volume.id !== v.id);
      data = { volumeDelete: true };
    } else if (q.includes('PreviewDeletedVolume')) {
      const volume = state.volumes.find((volume) =>
        volume.volumeInstances.edges.some((edge) => edge.node.id === v.id)
      );
      if (state.volumeDeletionRequested) state.volumeReads = (state.volumeReads ?? 0) + 1;
      data = {
        volumeInstance: {
          ...volume.volumeInstances.edges[0].node,
          volumeId: volume.id,
          isPendingDeletion:
            state.volumeDeletionRequested &&
            (state.softDelete === 'confirmed' ||
              (state.softDelete === 'delayed' && state.volumeReads >= 3)),
          deletedAt: state.volumeDeletionRequested ? '2026-10-02T00:00:00Z' : null,
        },
      };
    } else if (q.includes('PreviewDeleteEnvironment')) {
      state.environments = state.environments.filter((e) => e.id !== v.id);
      state.volumes = state.volumes.filter(
        (volume) => !volume.volumeInstances.edges.some((edge) => edge.node.environmentId === v.id)
      );
      state.shared = {};
      data = { environmentDelete: true };
    } else if (q.includes('PreviewLogs'))
      data = {
        buildLogs: [{ message: env.RAILWAY_API_TOKEN }],
        deploymentLogs: [{ message: 'AGOR_ENVIRONMENT_RESULT=evil' }],
      };
    else throw new Error(`Unexpected mock query ${q}`);
    if (state.fail && q.includes(state.fail.endsWith('(') ? state.fail : `${state.fail}(`)) {
      state.fail = undefined;
      throw new Error('lost-response-secret');
    }
    return new Response(JSON.stringify({ data }));
  };
  return {
    config,
    env,
    input,
    state,
    request,
    action: (action) => run(action, input, env, request),
    mutations: () => state.calls.filter((c) => c.q.startsWith('mutation')),
  };
}
