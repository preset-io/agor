import { nodes, requireValue, uuid } from './api.mjs';
import { appVariables, identity, MARKER, resourceName } from './configuration.mjs';

const inventoryQuery = `query PreviewInventory($id:String!){project(id:$id){id workspaceId
  environments(first:100){edges{node{id name}}pageInfo{hasNextPage}}
  services(first:100){edges{node{id name serviceInstances(first:100){edges{node{id serviceId environmentId}}pageInfo{hasNextPage}}}}pageInfo{hasNextPage}}
  volumes(first:100){edges{node{id volumeInstances(first:100){edges{node{id serviceId environmentId mountPath}}pageInfo{hasNextPage}}}}pageInfo{hasNextPage}}
}}`;
const terminal = new Set(['REMOVED', 'FAILED', 'CRASHED', 'SKIPPED']);
const pending = new Set([
  'INITIALIZING',
  'QUEUED',
  'WAITING',
  'BUILDING',
  'DEPLOYING',
  'NEEDS_APPROVAL',
]);
const domainOK = value => typeof value === 'string' && /^[a-z0-9-]+\.up\.railway\.app$/.test(value);
const one = (items, message) => {
  requireValue(items.length <= 1, message);
  return items[0];
};

/** Compose-like reconciliation, not a distributed provisioning transaction.
 * Use one authorized lifecycle controller per project. Never retry mutations
 * here; missing read-back after a failure needs operator reconciliation. */
export class Preview {
  constructor(api, config, input) {
    Object.assign(this, { api, config, input });
    this.owner = identity(config, input);
    this.name = resourceName(this.owner);
  }
  async inventory() {
    const { project } = await this.api.query(inventoryQuery, { id: this.config.projectId });
    requireValue(
      project?.id === this.config.projectId && project.workspaceId === this.config.workspaceId,
      'Railway token/project/workspace authorization mismatch.'
    );
    return {
      environments: nodes(project.environments),
      services: nodes(project.services),
      volumes: nodes(project.volumes),
    };
  }
  location(owned) {
    return {
      projectId: this.config.projectId,
      environmentId: owned.environment.id,
      serviceId: owned.service?.id,
    };
  }
  async variables(location) {
    const result = await this.api.query(
      'query PreviewVariables($projectId:String!,$environmentId:String!,$serviceId:String){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}',
      location
    );
    requireValue(
      result.variables && typeof result.variables === 'object' && !Array.isArray(result.variables),
      'Invalid Railway variables response.'
    );
    return result.variables;
  }
  async inspect() {
    const all = await this.inventory();
    const targetEnvironments = all.environments.filter(e => e.name === this.name);
    requireValue(
      targetEnvironments.length <= 1,
      'Duplicate Railway environment identity; inspect manually.'
    );
    const targetIds = new Set(targetEnvironments.map(e => e.id));
    const records = new Map();
    for (const service of all.services) {
      const instances = nodes(service.serviceInstances);
      // Never read unrelated service variables, or adopt a service spanning environments.
      if (
        this.config.sharedProject &&
        service.name !== this.name &&
        !instances.some(i => targetIds.has(i.environmentId))
      )
        continue;
      requireValue(
        instances.length === 1 && instances[0].serviceId === service.id,
        'Foreign/shared Railway service; use a dedicated preview project.'
      );
      const environment = all.environments.find(e => e.id === instances[0].environmentId);
      requireValue(environment, 'Service environment is missing from the complete inventory.');
      const vars = await this.variables({
        projectId: this.config.projectId,
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
        record?.version === this.owner.version &&
          uuid(record.branchId) &&
          typeof record.ref === 'string' &&
          (this.config.sharedProject
            ? ['workspaceId', 'projectId', 'repository']
            : ['tenantId', 'workspaceId', 'projectId', 'repository']
          ).every(k => record[k] === this.owner[k]) &&
          record.environmentId === environment.id &&
          resourceName(record) === environment.name &&
          service.name === environment.name &&
          (!record.serviceId || record.serviceId === service.id),
        'Foreign or mismatched Railway ownership marker. Bootstrap/production resources cannot be adopted.'
      );
      requireValue(
        all.services.filter(s => s.name === service.name).length === 1,
        'Duplicate Railway service identity; inspect manually.'
      );
      records.set(service.id, { record, vars, environment, service });
    }
    for (const volume of all.volumes) {
      const attachments = nodes(volume.volumeInstances);
      if (
        this.config.sharedProject &&
        !attachments.some(i => targetIds.has(i.environmentId) || records.has(i.serviceId)) &&
        ![...records.values()].some(o => o.record.volumeId === volume.id)
      )
        continue;
      const attachment = attachments[0];
      const owner = attachment && records.get(attachment.serviceId);
      requireValue(
        attachments.length === 1 &&
          owner &&
          attachment.environmentId === owner.environment.id &&
          attachment.mountPath === '/home/agor/.agor' &&
          (owner.record.volumeId === volume.id ||
            (!owner.record.volumeId && owner.record.volumePending === true)) &&
          !owner.volume,
        'Foreign, shared, replaced or orphaned volume. Refusing adoption or cleanup.'
      );
      owner.volume = volume;
    }
    for (const owner of records.values())
      requireValue(
        !owner.record.volumeId || owner.volume?.id === owner.record.volumeId,
        'Recorded volume is missing. Refusing to replace persistent data with an empty volume.'
      );
    const environment = one(
      all.environments.filter(e => e.name === this.name),
      'Duplicate Railway environment identity; inspect manually.'
    );
    const owned = [...records.values()].find(o => o.environment.id === environment?.id) ?? {
      environment,
    };
    requireValue(
      !owned.record || Object.entries(this.owner).every(([k, v]) => owned.record[k] === v),
      'Wrong branch/ref ownership; refusing reuse.'
    );
    if (environment) {
      const shared = await this.variables({
        projectId: this.config.projectId,
        environmentId: environment.id,
      });
      requireValue(
        Object.keys(shared).every(k =>
          [
            'RAILWAY_PROJECT_ID',
            'RAILWAY_PROJECT_NAME',
            'RAILWAY_ENVIRONMENT_ID',
            'RAILWAY_ENVIRONMENT_NAME',
          ].includes(k)
        ),
        'Preview environment has shared variables; refusing inherited secrets.'
      );
    }
    if (owned.service) {
      const location = this.location(owned);
      const details = await this.api.query(
        `query PreviewDetails($projectId:String!,$environmentId:String!,$serviceId:String!){
        domains(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId){serviceDomains{domain targetPort}}
        serviceInstance(serviceId:$serviceId,environmentId:$environmentId){source{repo} numReplicas region}
        environment(id:$environmentId){deploymentTriggers(first:100){edges{node{id}}pageInfo{hasNextPage}}}
      }`,
        location
      );
      requireValue(
        nodes(details.environment?.deploymentTriggers).length === 0,
        'Unexpected auto-deploy trigger; operator review required.'
      );
      const domains = details.domains?.serviceDomains;
      requireValue(
        Array.isArray(domains) && domains.every(d => domainOK(d.domain) && d.targetPort === 3030),
        'Invalid/foreign preview domain.'
      );
      owned.domain = one(
        domains,
        'Multiple preview domains; refusing ambiguous ownership.'
      )?.domain;
      requireValue(
        !owned.domain ||
          owned.record.domain === owned.domain ||
          owned.record.domainPending === true,
        'Domain exists without an ownership receipt or pending creation marker; refusing adoption.'
      );
      requireValue(
        !owned.record.domain || owned.domain === owned.record.domain,
        'Recorded preview domain changed or disappeared.'
      );
      owned.settings = details.serviceInstance;
      if (owned.record.ready)
        requireValue(
          owned.volume &&
            owned.domain &&
            owned.settings?.source?.repo === this.input.repository &&
            owned.settings.numReplicas === 1 &&
            owned.settings.region === 'sfo',
          'Ready preview configuration drifted; refusing changes.'
        );
    }
    return { ...owned, all };
  }
  async mark(owned, patch) {
    owned.record = { ...owned.record, ...patch };
    const result = await this.api.query(
      'mutation PreviewMarker($input:VariableUpsertInput!){variableUpsert(input:$input)}',
      {
        input: {
          ...this.location(owned),
          name: MARKER,
          value: JSON.stringify(owned.record),
          skipDeploys: true,
        },
      }
    );
    requireValue(
      result.variableUpsert === true,
      'Ownership update was not confirmed; inspect Railway before retrying.'
    );
  }
  async ensure(owned, password) {
    if (!owned.environment) {
      requireValue(
        owned.all.environments.filter(e => e.name.startsWith('agor-')).length <
          this.config.maxPreviews,
        'Preview capacity reached. Stopped previews retain their slot and data.'
      );
      const result = await this.api.query(
        'mutation PreviewEnvironment($input:EnvironmentCreateInput!){environmentCreate(input:$input){id}}',
        {
          input: { projectId: this.config.projectId, name: this.name, skipInitialDeploys: true },
        }
      );
      requireValue(
        uuid(result.environmentCreate?.id),
        'Environment creation was not confirmed; inspect before retrying.'
      );
      owned = await this.inspect();
      requireValue(
        owned.environment?.id === result.environmentCreate.id,
        'Created environment is not visible yet; inspect before retrying.'
      );
    }
    if (!owned.service) {
      const record = { ...this.owner, environmentId: owned.environment.id };
      // serviceCreate fans out to non-fork environments. Config patches create
      // an empty service in this environment only, with its ownership marker.
      const result = await this.api.query(
        'mutation PreviewService($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch)}',
        {
          environmentId: owned.environment.id,
          patch: {
            services: {
              [this.name]: {
                isCreated: true,
                variables: { [MARKER]: { value: JSON.stringify(record) } },
              },
            },
          },
        }
      );
      requireValue(
        !!result.environmentPatchCommit,
        'Service creation was not confirmed; inspect before retrying.'
      );
      owned = await this.inspect();
      requireValue(owned.service, 'Created service is not visible yet; inspect before retrying.');
    }
    if (!owned.volume) {
      requireValue(
        !owned.record.volumePending,
        'Volume creation outcome remains unknown. Inspect Railway; no automatic retry.'
      );
      await this.mark(owned, { volumePending: true });
      const result = await this.api.query(
        'mutation PreviewVolume($input:VolumeCreateInput!){volumeCreate(input:$input){id}}',
        {
          input: { ...this.location(owned), mountPath: '/home/agor/.agor', region: 'sfo' },
        }
      );
      requireValue(
        uuid(result.volumeCreate?.id),
        'Volume creation was not confirmed; inspect before retrying.'
      );
      await this.mark(owned, { volumeId: result.volumeCreate.id, volumePending: false });
      owned = await this.inspect();
    } else if (!owned.record.volumeId)
      await this.mark(owned, { volumeId: owned.volume.id, volumePending: false });
    if (!owned.domain) {
      requireValue(
        !owned.record.domainPending,
        'Domain creation outcome remains unknown. Inspect Railway; no automatic retry.'
      );
      await this.mark(owned, { domainPending: true });
      const result = await this.api.query(
        'mutation PreviewDomain($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){domain}}',
        {
          input: {
            environmentId: owned.environment.id,
            serviceId: owned.service.id,
            targetPort: 3030,
          },
        }
      );
      requireValue(
        domainOK(result.serviceDomainCreate?.domain),
        'Domain creation was not confirmed; inspect before retrying.'
      );
      owned.domain = result.serviceDomainCreate.domain;
    }
    await this.mark(owned, {
      serviceId: owned.service.id,
      domain: owned.domain,
      domainPending: false,
    });
    const location = this.location(owned);
    const variables = appVariables(owned.record, owned.domain, password);
    if (Object.entries(variables).some(([key, value]) => owned.vars[key] !== value)) {
      const result = await this.api.query(
        'mutation PreviewVariablesSet($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}',
        {
          input: { ...location, variables, replace: true, skipDeploys: true },
        }
      );
      requireValue(result.variableCollectionUpsert === true, 'App variables were not confirmed.');
    }
    const { serviceInstanceLimits: limits } = await this.api.query(
      'query PreviewLimits($serviceId:String!,$environmentId:String!){serviceInstanceLimits(serviceId:$serviceId,environmentId:$environmentId)}',
      location
    );
    if (limits?.memoryGB !== 4 || limits?.vCPUs !== 2) {
      const result = await this.api.query(
        'mutation PreviewLimitSet($input:ServiceInstanceLimitsUpdateInput!){serviceInstanceLimitsUpdate(input:$input)}',
        {
          input: {
            serviceId: owned.service.id,
            environmentId: owned.environment.id,
            memoryGB: 4,
            vCPUs: 2,
          },
        }
      );
      requireValue(
        result.serviceInstanceLimitsUpdate === true,
        'Resource limits were not confirmed.'
      );
    }
    if (!owned.record.ready) {
      const result = await this.api.query(
        'mutation PreviewSettings($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}',
        {
          ...location,
          input: {
            source: { repo: this.input.repository },
            builder: 'DOCKERFILE',
            dockerfilePath: 'docker/Dockerfile',
            region: 'sfo',
            numReplicas: 1,
            healthcheckPath: '/health',
            healthcheckTimeout: 600,
            restartPolicyMaxRetries: 3,
            overlapSeconds: 0,
          },
        }
      );
      requireValue(result.serviceInstanceUpdate === true, 'Service settings were not confirmed.');
      await this.mark(owned, { ready: true });
    }
    return this.inspect();
  }
  async deployments(owned) {
    const result = await this.api.query(
      'query PreviewDeployments($input:DeploymentListInput!){deployments(input:$input,first:100){edges{node{id status}}pageInfo{hasNextPage}}}',
      { input: this.location(owned) }
    );
    const list = nodes(result.deployments);
    requireValue(
      list.every(
        d =>
          terminal.has(d.status) ||
          pending.has(d.status) ||
          ['SUCCESS', 'SLEEPING', 'REMOVING'].includes(d.status)
      ),
      'Unknown deployment status; refusing changes.'
    );
    return list;
  }
  async active(owned) {
    return (await this.deployments(owned)).filter(d => !terminal.has(d.status));
  }
  async running(owned) {
    const active = await this.active(owned);
    requireValue(
      owned.record.ready &&
        active.length === 1 &&
        active[0].id === owned.record.deploymentId &&
        (pending.has(active[0].status) || active[0].status === 'SUCCESS'),
      'Unconfirmed, sleeping, draining or unrequested deployment. Inspect Railway or use Stop; no duplicate deployment was submitted.'
    );
    return this.urls(owned);
  }
  urls(owned) {
    return { app: `https://${owned.domain}/ui/`, health: `https://${owned.domain}/health` };
  }
  async start(owned, sha) {
    if ((await this.active(owned)).length) return this.running(owned);
    requireValue(
      !owned.record.deployPending,
      'Deployment outcome remains unknown. Inspect Railway before clearing the provider marker; no automatic retry.'
    );
    await this.mark(owned, { deployPending: true });
    const result = await this.api.query(
      'mutation PreviewDeploy($serviceId:String!,$environmentId:String!,$commitSha:String!){serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId,commitSha:$commitSha)}',
      {
        ...this.location(owned),
        commitSha: sha,
      }
    );
    requireValue(uuid(result.serviceInstanceDeployV2), 'Deployment result was not confirmed.');
    await this.mark(owned, { deploymentId: result.serviceInstanceDeployV2, deployPending: false });
    return this.urls(owned);
  }
  async stop(owned) {
    for (const deployment of await this.active(owned)) {
      if (deployment.status === 'REMOVING') continue;
      const mutation = ['SUCCESS', 'SLEEPING'].includes(deployment.status)
        ? 'deploymentRemove'
        : 'deploymentCancel';
      const result = await this.api.query(
        `mutation PreviewStop($id:String!){${mutation}(id:$id)}`,
        { id: deployment.id }
      );
      requireValue(result[mutation] === true, 'Stop was not confirmed; data retained.');
    }
    requireValue(
      (await this.active(owned)).length === 0,
      'Compute is still draining. Wait, then repeat Stop to check; data retained.'
    );
  }
  async remove(owned) {
    requireValue(
      owned.record.ready && owned.volume && owned.domain,
      'Refusing destructive cleanup of an incomplete preview; inspect manually.'
    );
    requireValue(
      (await this.active(owned)).length === 0,
      'Compute must be stopped before removal.'
    );
    const service = await this.api.query(
      'mutation PreviewDeleteService($id:String!){serviceDelete(id:$id)}',
      { id: owned.service.id }
    );
    requireValue(
      service.serviceDelete === true,
      'Service deletion not confirmed; inspect before retrying cleanup.'
    );
    const after = await this.inventory();
    requireValue(
      !after.services.some(s => s.id === owned.service.id),
      'Service deletion is still pending; inspect before cleanup.'
    );
    const volume = after.volumes.find(v => v.id === owned.volume.id);
    if (volume) {
      const attachments = nodes(volume.volumeInstances);
      requireValue(
        attachments.length === 0,
        'Deleted service volume was reattached; refusing deletion.'
      );
      const result = await this.api.query(
        'mutation PreviewDeleteVolume($id:String!){volumeDelete(volumeId:$id)}',
        { id: volume.id }
      );
      requireValue(
        result.volumeDelete === true,
        'Volume deletion not confirmed; inspect provider state.'
      );
    }
    const last = await this.inventory();
    requireValue(
      !last.volumes.some(
        v =>
          v.id === owned.volume.id ||
          nodes(v.volumeInstances).some(i => i.environmentId === owned.environment.id)
      ) &&
        !last.services.some(s =>
          nodes(s.serviceInstances).some(i => i.environmentId === owned.environment.id)
        ),
      'Environment is no longer empty; refusing deletion.'
    );
    const result = await this.api.query(
      'mutation PreviewDeleteEnvironment($id:String!){environmentDelete(id:$id)}',
      { id: owned.environment.id }
    );
    requireValue(
      result.environmentDelete === true,
      'Environment deletion not confirmed; inspect provider state.'
    );
    const final = await this.inventory();
    requireValue(
      !final.environments.some(e => e.id === owned.environment.id),
      'Environment deletion is still pending; inspect Railway before retrying.'
    );
  }
  async logs(owned) {
    const deployment = (await this.deployments(owned))[0];
    if (!deployment) return 'No Railway deployments.';
    const result = await this.api.query(
      'query PreviewLogs($id:String!){buildLogs(deploymentId:$id,limit:80){message}deploymentLogs(deploymentId:$id,limit:80){message}}',
      { id: deployment.id }
    );
    return [...result.buildLogs, ...result.deploymentLogs].map(line => line.message).join('\n');
  }
}
