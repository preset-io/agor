import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { resetVolume, VOLUME_STATE_VARIABLE, volumeState } from './volume-reset.mjs';

const API = 'https://backboard.railway.com/graphql/v2';
const TERMINAL = new Set(['REMOVED', 'FAILED', 'CRASHED', 'SKIPPED']);
const PENDING = new Set([
  'INITIALIZING',
  'QUEUED',
  'WAITING',
  'BUILDING',
  'DEPLOYING',
  'NEEDS_APPROVAL',
]);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function selectBinding(bindings, { binding, repository, ref }) {
  const target = bindings[binding];
  if (
    !UUID.test(binding ?? '') ||
    !target ||
    target.repository !== repository ||
    target.ref !== ref
  ) {
    throw new Error(
      'No Railway resource binding for this branch/repository/ref. Provision a separate preview first.'
    );
  }
  for (const key of ['projectId', 'environmentId', 'serviceId', 'volumeId']) {
    if (!UUID.test(target[key] ?? '')) throw new Error('Invalid Railway resource binding');
  }
  if (!/^[a-z0-9-]+\.up\.railway\.app$/.test(target.domain))
    throw new Error('Invalid Railway domain binding');
  if (
    Object.entries(bindings).some(
      ([key, other]) =>
        key !== binding &&
        (other.serviceId === target.serviceId || other.volumeId === target.volumeId)
    )
  ) {
    throw new Error('Railway service/volume is bound to more than one branch');
  }
  return { ...target, binding };
}

export class RailwayClient {
  constructor(token, { request = fetch, signal, accountToken = false } = {}) {
    if (!token)
      throw new Error(
        'Save RAILWAY_API_KEY (Railway environment-scoped project token) in your secure global environment.'
      );
    this.token = token;
    this.accountToken = accountToken;
    this.request = request;
    this.signal = signal;
  }
  async query(query, variables = {}) {
    // No redirects, arbitrary API destinations, secret logging, or mutation retries.
    try {
      const response = await this.request(API, {
        method: 'POST',
        redirect: 'error',
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/json',
          ...(this.accountToken
            ? { Authorization: `Bearer ${this.token}` }
            : { 'Project-Access-Token': this.token }),
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (result.errors?.length || !result.data) throw new Error();
      return result.data;
    } catch {
      throw new Error(
        'Railway API request failed or was interrupted; inspect provider state before retrying. Credentials/response withheld.'
      );
    }
  }
}

export class RailwayPreview {
  constructor(
    client,
    target,
    {
      env = process.env,
      request = fetch,
      signal,
      wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now = Date.now,
      report = () => {},
    } = {}
  ) {
    Object.assign(this, { client, target, env, request, signal, wait, now, report });
  }
  async inspect({ allowPendingReset = false } = {}) {
    const t = this.target;
    const data = await this.client.query(
      `query Inspect($projectId:String!,$environmentId:String!,$serviceId:String!) {
      projectToken { projectId environmentId }
      environment(id:$environmentId) { projectId deploymentTriggers { edges { node { id repository branch serviceId provider } } }
        volumeInstances { edges { node { volumeId serviceId mountPath } } } }
      serviceInstance(serviceId:$serviceId,environmentId:$environmentId) { source { repo } domains { serviceDomains { domain targetPort } } }
      variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
    }`,
      { projectId: t.projectId, environmentId: t.environmentId, serviceId: t.serviceId }
    );
    if (
      data.projectToken.projectId !== t.projectId ||
      data.projectToken.environmentId !== t.environmentId ||
      data.environment.projectId !== t.projectId ||
      data.serviceInstance.source.repo !== t.repository ||
      data.variables.AGOR_MANAGED_BRANCH_ID !== t.binding ||
      data.variables.AGOR_SOURCE_BRANCH !== t.ref ||
      data.variables.AGOR_SOURCE_REPO !== `https://github.com/${t.repository}.git`
    ) {
      throw new Error('Railway ownership/source mismatch; refusing to operate.');
    }
    const state = volumeState(data.variables[VOLUME_STATE_VARIABLE], t);
    if (state.phase !== 'ready' && !allowPendingReset)
      throw new Error('Interrupted volume reset; operator reconciliation required');
    const volumes = data.environment.volumeInstances.edges
      .map(({ node }) => node)
      .filter((v) => v.serviceId === t.serviceId);
    if (
      state.phase === 'ready' &&
      (volumes.length !== 1 ||
        volumes[0].volumeId !== state.volumeId ||
        volumes[0].mountPath !== '/home/agor/.agor')
    ) {
      throw new Error('Railway volume binding mismatch; refusing to operate.');
    }
    const domains = data.serviceInstance.domains.serviceDomains;
    if (!domains.some((d) => d.domain === t.domain && d.targetPort === 3030))
      throw new Error('Railway domain binding changed; operator must review the new domain.');
    const triggers = data.environment.deploymentTriggers.edges
      .map(({ node }) => node)
      .filter((v) => v.serviceId === t.serviceId);
    if (
      triggers.length > 1 ||
      triggers.some(
        (v) => v.repository !== t.repository || v.branch !== t.ref || v.provider !== 'github'
      )
    ) {
      throw new Error('Unexpected Railway deployment trigger; refusing to operate.');
    }
    return { triggers, volumeId: state.volumeId, state };
  }
  async deployments() {
    const t = this.target;
    const nodes = [];
    let after;
    for (let page = 0; page < 20; page++) {
      const data = await this.client.query(
        `query Deployments($input:DeploymentListInput!,$after:String) {
        deployments(input:$input,first:100,after:$after) { edges { node { id status } } pageInfo { hasNextPage endCursor } }
      }`,
        {
          input: { projectId: t.projectId, environmentId: t.environmentId, serviceId: t.serviceId },
          after,
        }
      );
      nodes.push(...data.deployments.edges.map(({ node }) => node));
      if (!data.deployments.pageInfo.hasNextPage) return nodes;
      after = data.deployments.pageInfo.endCursor;
    }
    throw new Error('Deployment inventory exceeded its safety bound; no cleanup attempted.');
  }
  async setVolumeState(state) {
    const t = this.target;
    await this.client.query(
      'mutation VolumeState($input:VariableUpsertInput!){variableUpsert(input:$input)}',
      {
        input: {
          projectId: t.projectId,
          environmentId: t.environmentId,
          serviceId: t.serviceId,
          name: VOLUME_STATE_VARIABLE,
          value: JSON.stringify(state),
          skipDeploys: true,
        },
      }
    );
  }
  async setVariables() {
    const password = this.env.RAILWAY_AGOR_ADMIN_PASSWORD;
    if (!password || [...password].length < 15 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error(
        'Save a valid RAILWAY_AGOR_ADMIN_PASSWORD in your secure global environment. Existing users are not reset.'
      );
    }
    const t = this.target;
    const variables = {
      AGOR_ADMIN_PASSWORD: password,
      AGOR_RUNTIME_TARGET: 'runtime-build',
      AGOR_RUNTIME_MODE: 'watch',
      AGOR_SOURCE_REPO: `https://github.com/${t.repository}.git`,
      AGOR_SOURCE_BRANCH: t.ref,
      AGOR_MANAGED_BRANCH_ID: t.binding,
      AGOR_AGENTIC_TOOLS: 'claude-code,codex,opencode,copilot',
      AGOR_RUNTIME_ADD_TOOLS: 'claude-code,codex,opencode,copilot',
      AGOR_BASE_URL: `https://${t.domain}`,
      CORS_ORIGIN: `https://${t.domain}`,
    };
    await this.client.query(
      'mutation Variables($input:VariableCollectionUpsertInput!) { variableCollectionUpsert(input:$input) }',
      {
        input: {
          projectId: t.projectId,
          environmentId: t.environmentId,
          serviceId: t.serviceId,
          variables,
          skipDeploys: true,
          replace: false,
        },
      }
    );
  }
  async start() {
    await this.inspect();
    await this.setVariables();
    const t = this.target;
    // Environment-scoped project tokens can deploy this connected source but
    // cannot create GitHub deployment triggers. Keep stopped previews stopped
    // across pushes; Play/Restart deploy the latest pushed branch explicitly.
    const active = (await this.deployments()).filter((d) => !TERMINAL.has(d.status));
    if (
      active.some(
        (d) =>
          !PENDING.has(d.status) &&
          d.status !== 'SUCCESS' &&
          d.status !== 'SLEEPING' &&
          d.status !== 'REMOVING'
      )
    )
      throw new Error('Unknown Railway deployment state');
    if (active.some((d) => d.status === 'SLEEPING'))
      throw new Error('Sleeping deployment found; use Stop then Start explicitly.');
    let deployment =
      active.find((d) => PENDING.has(d.status)) ?? active.find((d) => d.status === 'SUCCESS');
    if (!deployment) {
      const response = await this.request(
        `https://api.github.com/repos/${t.repository}/commits/${encodeURIComponent(t.ref)}`,
        { redirect: 'error', signal: AbortSignal.timeout(30_000) }
      );
      if (!response.ok) throw new Error('Cannot resolve the pushed GitHub branch');
      const { sha } = await response.json();
      if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('Invalid GitHub revision');
      const result = await this.client.query(
        'mutation Deploy($serviceId:String!,$environmentId:String!,$commitSha:String!) { serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId,commitSha:$commitSha) }',
        { serviceId: t.serviceId, environmentId: t.environmentId, commitSha: sha }
      );
      deployment = { id: result.serviceInstanceDeployV2 };
    }
    const deadline = this.now() + 18 * 60_000;
    let reportedStatus;
    while (this.now() < deadline) {
      this.signal?.throwIfAborted();
      const { deployment: current } = await this.client.query(
        'query Deployment($id:String!) { deployment(id:$id) { status } }',
        { id: deployment.id }
      );
      if (reportedStatus !== current.status) {
        this.report(`Railway deployment status: ${current.status}`);
        reportedStatus = current.status;
      }
      if (TERMINAL.has(current.status))
        throw new Error(
          'Railway deployment did not become ready. Use Logs or Stop; no automatic retry was made.'
        );
      if (current.status === 'SUCCESS') {
        try {
          const response = await this.request(`https://${t.domain}/health`, {
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok && (await response.json()).status === 'ok') {
            await this.inspect();
            return { app: `https://${t.domain}/ui/`, health: `https://${t.domain}/health` };
          }
        } catch {
          /* Readiness can lag provider status. No mutation retry. */
        }
      }
      await this.wait(5_000);
    }
    throw new Error(
      'Railway readiness timed out. Resources may still be running; use Stop before abandoning this preview.'
    );
  }
  async stop() {
    const { triggers } = await this.inspect({ allowPendingReset: true });
    // Disable future GitHub pushes before draining queued and active deployments.
    for (const trigger of triggers)
      await this.client.query('mutation Disable($id:String!) { deploymentTriggerDelete(id:$id) }', {
        id: trigger.id,
      });
    const deadline = this.now() + 120_000;
    const requested = new Set();
    while (this.now() < deadline) {
      this.signal?.throwIfAborted();
      await this.inspect({ allowPendingReset: true });
      const active = (await this.deployments()).filter((d) => !TERMINAL.has(d.status));
      if (!active.length) return;
      for (const deployment of active) {
        if (deployment.status === 'REMOVING' || requested.has(deployment.id)) continue;
        if (!['SUCCESS', 'SLEEPING'].includes(deployment.status) && !PENDING.has(deployment.status))
          throw new Error('Unknown Railway deployment state; inspect before cleanup');
        const mutation = ['SUCCESS', 'SLEEPING'].includes(deployment.status)
          ? 'deploymentRemove'
          : 'deploymentCancel';
        await this.client.query(`mutation Stop($id:String!) { ${mutation}(id:$id) }`, {
          id: deployment.id,
        });
        requested.add(deployment.id);
      }
      await this.wait(3_000);
    }
    throw new Error('Railway stop is not confirmed; inspect provider state. Volume retained.');
  }
  async logs() {
    await this.inspect({ allowPendingReset: true });
    const latest = (await this.deployments())[0];
    if (!latest) return 'No Railway deployments.';
    const result = await this.client.query(
      'query Logs($id:String!) { buildLogs(deploymentId:$id,limit:80) { message } deploymentLogs(deploymentId:$id,limit:80) { message } }',
      { id: latest.id }
    );
    let output = [...result.buildLogs, ...result.deploymentLogs]
      .map((line) => line.message)
      .join('\n');
    // Provider logs are untrusted; remove control records, known secrets and common token shapes.
    for (const value of Object.values(this.env).filter(
      (value) => typeof value === 'string' && value.length >= 12
    ))
      output = output.split(value).join('[REDACTED]');
    return output
      .replace(/^.*AGOR_ENVIRONMENT_RESULT=.*$/gm, '[control record omitted]')
      .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/g, '[REDACTED]')
      .slice(-24_000);
  }
}

export async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      binding: { type: 'string' },
      repository: { type: 'string' },
      ref: { type: 'string' },
    },
  });
  const action = positionals[0];
  if (!['start', 'stop', 'logs', 'nuke'].includes(action) || positionals.length !== 1)
    throw new Error('Expected start, stop, logs or nuke');
  const bindings = JSON.parse(await readFile(new URL('./bindings.json', import.meta.url), 'utf8'));
  const target = selectBinding(bindings, values);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const parent = join(homedir(), '.agor', 'railway-lifecycle');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lock = join(parent, `${target.serviceId}.lock`);
  let locked = false;
  try {
    // Fail closed after SIGKILL rather than steal a possibly live provider action.
    if (action !== 'logs') {
      await mkdir(lock, { mode: 0o700 });
      locked = true;
    }
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: authorized caller's secure runtime environment.
    const client = new RailwayClient(process.env.RAILWAY_API_KEY || process.env.RAILWAY_TOKEN, {
      signal: controller.signal,
    });
    const preview = new RailwayPreview(client, target, {
      signal: controller.signal,
      report: (message) => console.error(message),
    });
    if (action === 'start')
      console.log(`AGOR_ENVIRONMENT_RESULT=${JSON.stringify(await preview.start())}`);
    if (action === 'stop') {
      await preview.stop();
      console.log('Railway stopped; GitHub auto-deploy disabled, volume retained.');
    }
    if (action === 'nuke') {
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: caller-owned operator credential; never sent to app.
      const token = process.env.RAILWAY_API_TOKEN;
      if (!token) {
        console.error(
          'Nuke requires RAILWAY_API_TOKEN (workspace token) in your secure environment.'
        );
        throw new Error('Nuke requires a workspace token');
      }
      await resetVolume(
        preview,
        new RailwayClient(token, { accountToken: true, signal: controller.signal })
      );
      console.log('Railway reset completed; new empty volume bound, compute stopped.');
    }
    if (action === 'logs') console.log(await preview.logs());
  } finally {
    if (locked) await rmdir(lock);
    process.off('SIGTERM', abort);
    process.off('SIGINT', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // No raw exception: network/config/provider errors can contain secrets.
    console.error(
      'Railway action failed. Check resource binding, secure variables and provider status. No automatic retry was performed. Nuke may have changed volume state; inspect before retrying.'
    );
    process.exitCode = 1;
  });
}
