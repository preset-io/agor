#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { io } from 'socket.io-client';

if (process.env.AGOR_HA_INTEGRATION !== '1') {
  console.log('SKIP: set AGOR_HA_INTEGRATION=1 to exercise the branch HA Compose stack');
  process.exit(0);
}

for (const name of [
  'AGOR_REDIS_KEY_PREFIX',
  'AGOR_JWT_SECRET',
  'AGOR_MASTER_SECRET',
  'AGOR_EXTERNAL_LAUNCH_SHARED_SECRET',
]) {
  assert(process.env[name], `${name} is required`);
}

const ingress = process.env.HA_URL ?? `http://127.0.0.1:${process.env.HA_PORT ?? '3030'}`;
const publicOrigin = process.env.AGOR_HA_PUBLIC_ORIGIN ?? ingress;
const daemonA = `http://127.0.0.1:${process.env.HA_DAEMON_A_PORT ?? '13031'}`;
const daemonB = `http://127.0.0.1:${process.env.HA_DAEMON_B_PORT ?? '13032'}`;
const project = process.env.COMPOSE_PROJECT_NAME ?? 'agor-ha-integration';
const compose = ['compose', '-f', 'docker-compose.ha.yml', '-p', project];
const cleanupFailures = [];
const cleanupDockerProcesses = new Set();

function cleanupWarning(message, error) {
  const detail = error instanceof Error ? error.message : error == null ? '' : String(error);
  const rendered = detail ? `${message}: ${detail}` : message;
  cleanupFailures.push(new Error(rendered));
  console.warn(`cleanup warning: ${rendered}`);
}

function docker(...args) {
  const result = spawnSync('docker', [...compose, ...args], { stdio: 'inherit', env: process.env });
  assert.equal(result.status, 0, `docker ${args.join(' ')} failed`);
}

function dockerOutput(...args) {
  const result = spawnSync('docker', [...compose, ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || `docker ${args.join(' ')} failed`);
  return result.stdout;
}

function dockerFileExists(service, path) {
  return (
    spawnSync('docker', [...compose, 'exec', '-T', service, 'test', '-e', path], {
      env: process.env,
      stdio: 'ignore',
    }).status === 0
  );
}

const CLAUDE_CONTAINMENT_ATTACK_SCRIPT = String.raw`
set -eu
must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected success: $*" >&2
    exit 70
  fi
}
attack_authority() {
  for claude_dir in "$@"; do
    replacement="$HOME/ha-claude-replacement-$(basename "$(dirname "$claude_dir")")"
    rm -rf "$replacement"
    mkdir -p "$replacement"
    must_fail mv "$claude_dir" "$claude_dir.renamed"
    must_fail rmdir "$claude_dir"
    must_fail mv -T "$replacement" "$claude_dir"
    for leaf in .credentials.json .agor-auth-generation .agor-auth-mutation.lock; do
      must_fail cat "$claude_dir/$leaf"
      must_fail sh -c 'printf attacker > "$1"' sh "$claude_dir/$leaf"
      must_fail unlink "$claude_dir/$leaf"
      must_fail ln -sfn "$replacement/attacker" "$claude_dir/$leaf"
    done
    eval "exec 9<\"$claude_dir\""
    must_fail sh -c 'printf attacker > /proc/self/fd/9/.credentials.json'
    must_fail sh -c 'printf 0 > /proc/self/fd/9/.agor-auth-generation'
    must_fail sh -c 'printf attacker > /proc/self/fd/9/.agor-auth-mutation.lock'
    eval 'exec 9<&-'
  done
}
attack_authority "$@"
printf ready > "$AGOR_HA_CONTAINMENT_READY"
while test ! -e "$AGOR_HA_CONTAINMENT_CONTINUE"; do sleep 0.02; done
attack_authority "$@"
`;

function startClaudeContainmentProbe(service, ownerHomeStore, probeName) {
  const ready = `${ownerHomeStore}/.claude/${probeName}.ready`;
  const proceed = `${ownerHomeStore}/.claude/${probeName}.continue`;
  const program = `
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSandboxWrap } from '/opt/agor-runtime/lib/node_modules/agor-live/dist/daemon/utils/sandbox-wrap.js';
import { ensureCredentialAuthorityLayout } from '/opt/agor-runtime/lib/node_modules/agor-live/node_modules/@agor/core/codex/credential-file.js';
import { hasContainedClaudeRuntimeCredentials } from '/opt/agor-runtime/lib/node_modules/agor-live/node_modules/@agor/core/config/index.js';

const [ownerHomeStore, ready, proceed] = process.argv.slice(2);
const containedConfig = {
  execution: {
    unix_user_mode: 'sandbox',
    executor_storage: { user_home: 'persistent-per-user' },
    sandbox: { enabled: true, home_mode: 'per_user' },
  },
};
if (!hasContainedClaudeRuntimeCredentials(containedConfig)) {
  throw new Error('HA containment probe rejected the exact contained topology');
}
if (
  hasContainedClaudeRuntimeCredentials({
    execution: {
      ...containedConfig.execution,
      sandbox: {
        ...containedConfig.execution.sandbox,
        extra_allow_write: [ownerHomeStore],
      },
    },
  })
) {
  throw new Error('HA containment probe admitted an extra writable physical-store escape');
}
const claudeDir = join(ownerHomeStore, '.claude');
const branch = join('/home/agor/.agor/worktrees', 'ha-containment', ${JSON.stringify(probeName)});
await mkdir(branch, { recursive: true });
await ensureCredentialAuthorityLayout(join(claudeDir, '.credentials.json'));
await rm(ready, { force: true });
await rm(proceed, { force: true });
const runtimePaths = {
  homeDir: '/home/agor',
  dataHome: '/home/agor/.agor',
  protectedDataRoots: ['/home/agor/.agor'],
  worktreesRoot: '/home/agor/.agor/worktrees',
  agenticToolsPath: '/home/agor/.agor/agentic-tools',
  agorConfigPath: '/home/agor/.agor/config.yaml',
};
const options = {
  sandbox: {
    enabled: true,
    home_mode: 'per_user',
    preserve_canonical_home_alias: true,
    fail_if_unavailable: true,
    include: { tmp: false },
    // Synthetic hostile topology: re-expose the initially hidden shared data
    // root. Managed Claude admission must reject it, while the sandbox's
    // unconditional masks must still protect an existing/dormant grant from
    // other provider tasks and terminals.
    extra_allow_write: ['/home/agor/.agor'],
  },
  branchPath: branch,
  ownerHomeStore,
  runtimePaths,
};
const discovery = buildSandboxWrap({ ...options, cmd: '/bin/true', args: [] });
if (!discovery) throw new Error('HA containment probe did not resolve a sandbox');
const aliases = [];
for (let index = 0; index < discovery.args.length - 2; index += 1) {
  if (
    discovery.args[index] === '--bind' &&
    discovery.args[index + 1] === claudeDir &&
    !aliases.includes(discovery.args[index + 2])
  ) aliases.push(discovery.args[index + 2]);
}
if (aliases.length === 0) throw new Error('HA containment probe found no live home alias');
const sandboxReady = join(aliases[0], ready.split('/').at(-1));
const sandboxProceed = join(aliases[0], proceed.split('/').at(-1));
for (const alias of aliases) {
  for (const leaf of ['.credentials.json', '.agor-auth-generation', '.agor-auth-mutation.lock']) {
    const target = join(alias, leaf);
    const masked = discovery.args.some(
      (arg, index) =>
        arg === '--ro-bind' &&
        discovery.args[index + 1] === '/dev/null' &&
        discovery.args[index + 2] === target
    );
    if (!masked) throw new Error('HA containment probe found an unmasked authority leaf: ' + target);
  }
}
const wrapped = buildSandboxWrap({
  ...options,
  cmd: '/bin/bash',
  args: ['-c', ${JSON.stringify(CLAUDE_CONTAINMENT_ATTACK_SCRIPT)}, 'bash', ...aliases],
});
if (!wrapped) throw new Error('HA containment probe failed to build its live sandbox');
const result = spawnSync(wrapped.cmd, wrapped.args, {
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH,
    AGOR_HA_CONTAINMENT_READY: sandboxReady,
    AGOR_HA_CONTAINMENT_CONTINUE: sandboxProceed,
  },
});
if (result.status !== 0) {
  throw new Error('HA containment attack escaped or failed: ' + result.status + '\\n' + result.stdout + '\\n' + result.stderr);
}
`;
  const child = spawn(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      service,
      'node',
      '--input-type=module',
      '-',
      ownerHomeStore,
      ready,
      proceed,
    ],
    { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const cleanupRecord = { child, service, proceed, completion: undefined };
  cleanupDockerProcesses.add(cleanupRecord);
  child.stdin.end(program);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      cleanupDockerProcesses.delete(cleanupRecord);
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${service} Claude containment probe failed (${code ?? signal}): ${stdout}${stderr}`
            )
          );
    });
  });
  cleanupRecord.completion = completion;
  return { ready, proceed, completion };
}

function claudeAuthoritySnapshot(service, claudeConfigDir) {
  const output = dockerOutput(
    'exec',
    '-T',
    service,
    'sh',
    '-c',
    `set -eu; for leaf in .credentials.json .agor-auth-generation .agor-auth-mutation.lock; do path='${claudeConfigDir}'/"$leaf"; printf '%s ' "$leaf"; stat -c '%i' "$path"; sha256sum "$path" | cut -d' ' -f1; done`
  )
    .trim()
    .split('\n');
  const snapshot = {};
  for (let index = 0; index < output.length; index += 2) {
    const [leaf, inode] = output[index].split(' ');
    snapshot[leaf] = { inode, sha256: output[index + 1] };
  }
  return snapshot;
}

function composeServiceContainerId(service) {
  const result = spawnSync('docker', [...compose, 'ps', '-a', '-q', service], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || `could not resolve Compose service ${service}`);
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
  assert.equal(ids.length, 1, `expected exactly one container for Compose service ${service}`);
  return ids[0];
}

function serviceMountDestinations(service) {
  const result = spawnSync(
    'docker',
    ['inspect', composeServiceContainerId(service), '--format', '{{json .Mounts}}'],
    { encoding: 'utf8', env: process.env }
  );
  assert.equal(result.status, 0, result.stderr || `could not inspect Compose service ${service}`);
  return new Set(JSON.parse(result.stdout.trim()).map((mount) => mount.Destination));
}

/** Start exactly the stopped container, without Compose starting its dependencies. */
function startServiceOnly(service) {
  const result = spawnSync('docker', ['start', composeServiceContainerId(service)], {
    stdio: 'inherit',
    env: process.env,
  });
  assert.equal(result.status, 0, `could not start Compose service ${service}`);
}

function startServiceOnlyBestEffort(service) {
  try {
    const result = spawnSync('docker', ['start', composeServiceContainerId(service)], {
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status !== 0) {
      cleanupWarning(`could not start Compose service ${service} (exit ${result.status})`);
      return false;
    }
    return true;
  } catch (error) {
    cleanupWarning(`could not start Compose service ${service}`, error);
    return false;
  }
}

async function waitFor(url, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      lastStatus = String(response.status);
      if (await predicate(response)) return;
    } catch {
      lastStatus = 'unreachable';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url} (last status ${lastStatus})`);
}

async function waitUntil(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const EXACTLY_ONCE_SETTLE_MS = 500;

function once(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function socketAuthentication(accessToken) {
  return (authorize) => {
    const configured = typeof accessToken === 'function' ? accessToken() : accessToken;
    authorize(configured ? { token: configured } : {});
  };
}

async function connectAuthenticated(url, accessToken) {
  const socket = io(url, {
    autoConnect: false,
    // Direct replica sockets isolate Redis/Feathers fanout from ingress
    // affinity. The separate ingress probe below deliberately exercises the
    // polling -> WebSocket upgrade path.
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 250,
    auth: socketAuthentication(accessToken),
  });
  const connected = once(socket, 'connect');
  socket.connect();
  await connected;
  return socket;
}

async function assertAnonymousHandshakeRejected(url) {
  const socket = io(url, {
    autoConnect: false,
    transports: ['websocket'],
    reconnection: false,
  });
  const rejected = once(socket, 'connect_error');
  socket.connect();
  const error = await rejected;
  assert.equal(socket.connected, false);
  assert.equal(error?.data?.code, 401);
  assert.equal(error?.data?.className, 'not-authenticated');
  socket.close();
}

async function authenticatedHealth(base, accessToken) {
  const response = await fetch(`${base}/health`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(response.status, 200, `authenticated health failed at ${base}`);
  return response.json();
}

function socketHealth(socket) {
  return new Promise((resolve, reject) => {
    socket.emit('find', 'health', {}, (error, result) =>
      error ? reject(new Error(error.message ?? String(error))) : resolve(result)
    );
  });
}

let cleanupAccessToken;
let cleanupApiKeyId;
const cleanupBoards = new Map();
let cleanupCodexAccessToken;
let cleanupClaudeAccessToken;
const cleanupSockets = new Set();
const cleanupStoppedServices = new Set();
let completed = false;
let primaryError;

try {
  if (process.env.AGOR_HA_INTEGRATION_START === '1') docker('up', '-d', '--build');
  // The Compose-only launcher source is bind-mounted rather than baked into an
  // image. Reusable stacks otherwise keep the old in-memory persona table after
  // the source changes, producing a false harness failure for new fixtures.
  docker('restart', 'dev-launcher');

  await Promise.all(
    [ingress, daemonA, daemonB].map((base) => waitFor(`${base}/readyz`, (r) => r.status === 200))
  );
  console.log('ok - two daemons and ingress are ready');

  for (const service of ['daemon-a', 'daemon-b']) {
    const destinations = serviceMountDestinations(service);
    assert(destinations.has('/home/agor'), `${service} is missing the shared container home mount`);
    assert(
      destinations.has('/home/agor/.agor'),
      `${service} is missing the stable Agor workspace/state mount`
    );
  }
  const mountProbe = `ha-mount-probe-${Date.now()}`;
  try {
    dockerOutput(
      'exec',
      '-T',
      'daemon-a',
      'sh',
      '-c',
      `printf '%s' '${mountProbe}' > /home/agor/.ha-user-home-probe && printf '%s' '${mountProbe}' > /home/agor/.agor/.ha-workspace-probe`
    );
    assert.equal(
      dockerOutput('exec', '-T', 'daemon-b', 'cat', '/home/agor/.ha-user-home-probe').trim(),
      mountProbe
    );
    assert.equal(
      dockerOutput('exec', '-T', 'daemon-b', 'cat', '/home/agor/.agor/.ha-workspace-probe').trim(),
      mountProbe
    );
  } finally {
    dockerOutput(
      'exec',
      '-T',
      'daemon-b',
      'rm',
      '-f',
      '/home/agor/.ha-user-home-probe',
      '/home/agor/.agor/.ha-workspace-probe'
    );
  }
  console.log('ok - shared storage carries stable tenant/user homes and Agor workspaces');

  for (const service of ['daemon-a', 'daemon-b']) {
    const doctor = JSON.parse(dockerOutput('exec', '-T', service, 'agor', 'doctor', '--json'));
    assert.equal(doctor.policy?.source, 'config.yaml');
    const diagnosedToolIds = doctor.agenticTools.map((tool) => tool.id).sort();
    assert.deepEqual(
      [...doctor.policy.selected].sort(),
      diagnosedToolIds,
      `${service} HA smoke policy does not select every managed agentic tool`
    );
    for (const tool of doctor.agenticTools) {
      assert.equal(
        tool.status,
        'ready',
        `${service} does not see the prepared ${tool.id} integration`
      );
    }
  }
  console.log('ok - all declarative agentic-tool integrations are ready on both replicas');

  const corsProbe = await fetch(`${ingress}/health`, {
    headers: { origin: publicOrigin },
  });
  assert.equal(corsProbe.status, 200, `same-ingress CORS probe failed: ${corsProbe.status}`);
  assert.equal(
    corsProbe.headers.get('access-control-allow-origin'),
    publicOrigin,
    'HA public ingress origin was not reflected by the daemon CORS allow-list'
  );
  console.log('ok - browser origin is accepted consistently through HA ingress');
  for (const service of ['daemon-a', 'daemon-b']) {
    const startupLogs = dockerOutput('logs', '--no-color', service);
    assert.match(startupLogs, /\[distributed-work\.environment-health\] event="loop_started"/);
    assert.match(startupLogs, /Task runtime reconciler started .*policy: shared_postgres/);
    assert.match(startupLogs, /\[distributed-work\.task-queue\] event="loop_started"/);
  }
  console.log('ok - both HA replicas activated distributed environment-health discovery');
  console.log('ok - both replicas activated shared runtime reconciliation and queue discovery');

  async function loginPersona({ tenant, persona }, base = daemonA) {
    const selected = await fetch(`${ingress}/dev-auth/select`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tenant, persona, return_to: '/ui/' }),
    });
    assert.equal(selected.status, 303, `persona selection failed: ${selected.status}`);
    const location = selected.headers.get('location');
    assert(location, 'persona selection did not return a launch redirect');
    const launchCode = new URL(location).searchParams.get('launch_code');
    assert(launchCode, 'persona selection did not return a launch code');
    assert(!location.includes('tenant_id='), 'persona redirect exposed a raw tenant selector');

    const response = await fetch(`${base}/auth/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ launchCode }),
    });
    assert.equal(response.status, 201, `persona launch failed: ${response.status}`);
    return response.json();
  }

  const picker = await fetch(`${ingress}/dev-auth/`);
  assert.equal(picker.status, 200);
  assert.match(await picker.text(), /HA development login/);
  const loginResult = await loginPersona({ tenant: 'acme', persona: 'acme-alice' });
  const foreignLoginResult = await loginPersona(
    { tenant: 'globex', persona: 'globex-beatrice' },
    daemonB
  );
  const memberLoginResult = await loginPersona({ tenant: 'acme', persona: 'acme-aaron' }, daemonB);
  const claudeLoginResult = await loginPersona(
    { tenant: 'acme', persona: 'acme-claude-ha' },
    daemonA
  );
  const { accessToken, refreshToken } = loginResult;
  const foreignAccessToken = foreignLoginResult.accessToken;
  const memberAccessToken = memberLoginResult.accessToken;
  const claudeAccessToken = claudeLoginResult.accessToken;
  const claudeUserId = claudeLoginResult.user?.user_id;
  const memberUserId = memberLoginResult.user?.user_id;
  const memberTokenPayload = JSON.parse(
    Buffer.from(memberAccessToken.split('.')[1], 'base64url').toString('utf8')
  );
  const memberTenantId =
    memberLoginResult.tenant?.tenant_id ??
    memberLoginResult.user?.tenant_id ??
    memberTokenPayload.tenant_id;
  const claudeTokenPayload = JSON.parse(
    Buffer.from(claudeAccessToken.split('.')[1], 'base64url').toString('utf8')
  );
  const claudeTenantId =
    claudeLoginResult.tenant?.tenant_id ??
    claudeLoginResult.user?.tenant_id ??
    claudeTokenPayload.tenant_id;
  assert.equal(typeof accessToken, 'string');
  assert.equal(typeof refreshToken, 'string');
  assert.equal(typeof foreignAccessToken, 'string');
  assert.equal(typeof memberAccessToken, 'string');
  assert.equal(typeof memberUserId, 'string');
  assert.equal(typeof memberTenantId, 'string');
  assert.equal(typeof claudeAccessToken, 'string');
  assert.equal(typeof claudeUserId, 'string');
  assert.equal(typeof claudeTenantId, 'string');
  cleanupAccessToken = accessToken;
  console.log('ok - dev picker JIT-provisioned independent admin identities in two tenants');

  const issueInstallState = async (base) => {
    const response = await fetch(`${base}/api/github/setup/state`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.status, 200, `GitHub install state issue failed: ${response.status}`);
    const body = await response.json();
    assert.match(body.state, /^[a-f0-9]{64}$/);
    return body.state;
  };

  // Issue through one daemon and consume through the peer's registered HTTP
  // route. A replay routed back to the issuer must fail after the shared atomic
  // delete commits.
  const peerState = await issueInstallState(daemonA);
  const peerCallback = await fetch(
    `${daemonB}/api/github/setup/callback?installation_id=4242&state=${encodeURIComponent(peerState)}`
  );
  assert.equal(peerCallback.status, 200);
  assert.match(await peerCallback.text(), /unverified installation ID/i);
  const peerReplay = await fetch(
    `${daemonA}/api/github/setup/callback?installation_id=4242&state=${encodeURIComponent(peerState)}`
  );
  assert.equal(peerReplay.status, 400);
  await peerReplay.text();
  console.log('ok - GitHub install state issues on one daemon and consumes once on its peer');

  // Exercise both state-bearing ingress paths, then prove nginx's logs omit
  // the complete request target rather than retaining the raw bearer.
  const ingressState = await issueInstallState(ingress);
  const setupPage = await fetch(
    `${ingress}/api/github/setup/new?name=Agor&state=${encodeURIComponent(ingressState)}`
  );
  assert.equal(setupPage.status, 200);
  await setupPage.text();
  const ingressCallback = await fetch(
    `${ingress}/api/github/setup/callback?installation_id=4343&state=${encodeURIComponent(ingressState)}`
  );
  assert.equal(ingressCallback.status, 200);
  await ingressCallback.text();
  const ingressLogs = dockerOutput('logs', '--no-color', 'ingress');
  assert(!ingressLogs.includes(ingressState), 'nginx logs retained raw GitHub setup state');
  console.log('ok - HA ingress logs redact GitHub setup query state');

  const invalidOAuthState = `ha-invalid-oauth-${Date.now()}`;
  const invalidOAuthCode = `ha-invalid-code-${Date.now()}`;
  const invalidOAuthCallback = await fetch(
    `${ingress}/mcp-servers/oauth-callback?code=${encodeURIComponent(invalidOAuthCode)}&state=${encodeURIComponent(invalidOAuthState)}`
  );
  assert.equal(invalidOAuthCallback.status, 409);
  await invalidOAuthCallback.text();
  const oauthIngressLogs = dockerOutput('logs', '--no-color', 'ingress');
  assert(!oauthIngressLogs.includes(invalidOAuthState), 'nginx logs retained raw MCP OAuth state');
  assert(!oauthIngressLogs.includes(invalidOAuthCode), 'nginx logs retained raw OAuth code');
  console.log(
    'ok - fleet-routed MCP OAuth callback is enabled and ingress logs redact capabilities'
  );

  if (process.env.AGOR_HA_INTEGRATION_FAILURES === '1') {
    // nginx's built-in error format includes the complete request and upstream
    // URI. Prove the sensitive route suppresses that unformattable log path
    // even when both peers are down and the bearer remains unconsumed.
    const failedUpstreamState = await issueInstallState(ingress);
    cleanupStoppedServices.add('daemon-a');
    cleanupStoppedServices.add('daemon-b');
    docker('stop', 'daemon-a', 'daemon-b');
    // Express accepts case variants, so nginx must apply the same sensitive
    // boundary to both the canonical path and a mixed-case spelling.
    for (const callbackPath of ['/api/github/setup/callback', '/API/GITHUB/SETUP/CALLBACK']) {
      const failedCallback = await fetch(
        `${ingress}${callbackPath}?installation_id=4444&state=${encodeURIComponent(failedUpstreamState)}`
      );
      assert(
        [502, 504].includes(failedCallback.status),
        `expected an upstream failure for ${callbackPath}, received ${failedCallback.status}`
      );
      await failedCallback.text();
    }
    for (const callbackPath of ['/mcp-servers/oauth-callback', '/MCP-SERVERS/OAUTH-CALLBACK']) {
      const failedCallback = await fetch(
        `${ingress}${callbackPath}?code=unconsumed-code&state=${encodeURIComponent(failedUpstreamState)}`
      );
      assert(
        [502, 504].includes(failedCallback.status),
        `expected an upstream failure for ${callbackPath}, received ${failedCallback.status}`
      );
      await failedCallback.text();
    }
    const failedIngressLogs = dockerOutput('logs', '--no-color', 'ingress');
    assert(
      !failedIngressLogs.includes(failedUpstreamState),
      'nginx failure-path logs retained raw GitHub setup state'
    );
    startServiceOnly('daemon-a');
    cleanupStoppedServices.delete('daemon-a');
    startServiceOnly('daemon-b');
    cleanupStoppedServices.delete('daemon-b');
    await Promise.all([
      waitFor(`${daemonA}/readyz`, (response) => response.status === 200),
      waitFor(`${daemonB}/readyz`, (response) => response.status === 200),
      waitFor(`${ingress}/readyz`, (response) => response.status === 200),
    ]);
    // Let nginx's configured fail_timeout elapse so later distribution probes
    // can admit both recovered peers rather than observing the quarantine.
    await delay(5_500);
    console.log('ok - HA ingress failure-path logs omit unconsumed GitHub setup state');
  }

  const browserCredential = { accessToken, handshakeCount: 0 };
  const currentBrowserAccessToken = () => {
    browserCredential.handshakeCount += 1;
    return browserCredential.accessToken;
  };
  const socketA = await connectAuthenticated(daemonA, currentBrowserAccessToken);
  const socketB = await connectAuthenticated(daemonB, currentBrowserAccessToken);
  cleanupSockets.add(socketA);
  cleanupSockets.add(socketB);
  const [healthA, healthB] = await Promise.all([socketHealth(socketA), socketHealth(socketB)]);
  assert.equal(healthA.deployment.instanceId, 'daemon-a');
  assert.equal(healthB.deployment.instanceId, 'daemon-b');
  assert.notEqual(healthA.deployment.bootId, healthB.deployment.bootId);
  assert.deepEqual(
    healthA.deployment.capabilities,
    healthB.deployment.capabilities,
    'HA replicas reported different resolved capability matrices'
  );
  for (const health of [healthA, healthB]) {
    assert.equal(health.deployment.supportProfile, 'constrained-active-active');
    assert.equal(health.deployment.capabilities.taskExecution, true);
    assert.equal(health.deployment.capabilities.executorTokenAuthority, true);
    assert.equal(health.deployment.capabilities.agorManagedInteractivePermissions, true);
    assert.equal(health.deployment.capabilities.scheduler, true);
    assert.equal(health.deployment.capabilities.sessionQueue, true);
    assert.equal(health.deployment.capabilities.taskRuntimeReconciliation, true);
    assert.equal(health.deployment.capabilities.knowledgeEmbeddingIndexer, true);
    assert.equal(health.deployment.capabilities.statelessMcp, true);
    assert.equal(health.deployment.capabilities.mcpOAuth, true);
    assert.equal(health.deployment.capabilities.completionCallbackDurableAdmission, true);
    assert.equal(health.deployment.capabilities.completionCallbackPreAdmissionRecovery, false);
    assert.equal(health.deployment.capabilities.widgetResolutionDurableClaim, true);
    assert.equal(health.deployment.capabilities.githubInstall, true);
    assert.equal(health.deployment.capabilities.gatewayListeners, true);
    assert.equal(health.deployment.capabilities.gatewayOutboundExactlyOnce, false);
    assert.equal(health.deployment.capabilities.environmentHealthMonitor, true);
    assert.equal(health.deployment.capabilities.codexCredentialFiles, true);
    assert.equal(health.deployment.capabilities.codexDeviceAuth, true);
    assert.equal(health.deployment.capabilities.claudeOAuth, true);
    assert.equal(health.deployment.capabilities.claudeAuth, true);
    assert.equal(health.deployment.realtime.ready, true);
  }
  console.log(
    'ok - distinct daemon/boot identities expose the constrained merged-foundation profile'
  );

  const authorizedClaudeConfig = await fetch(`${daemonB}/health`, {
    headers: { authorization: `Bearer ${memberAccessToken}` },
  });
  assert.equal(authorizedClaudeConfig.status, 200);
  assert.equal((await authorizedClaudeConfig.json()).features.claudeSubscriptionOAuth, true);
  console.log('ok - the HA validation profile explicitly authorizes Claude subscription OAuth');

  // Status is safe to probe without creating an uncontrolled provider device
  // attempt. Both replicas must admit it and observe the same durable state.
  const [codexDeviceStatusA, codexDeviceStatusB] = await Promise.all(
    [daemonA, daemonB].map((origin) =>
      fetch(`${origin}/codex-auth/device`, {
        headers: { authorization: `Bearer ${memberAccessToken}` },
      })
    )
  );
  assert.equal(codexDeviceStatusA.status, 200);
  assert.equal(codexDeviceStatusB.status, 200);
  assert.deepEqual(await codexDeviceStatusA.json(), await codexDeviceStatusB.json());

  const existingMemberCodexAuth = await fetch(`${daemonA}/check-auth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${memberAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool: 'codex', validateNative: true }),
  });
  assert.equal(existingMemberCodexAuth.status, 201);
  const existingMemberCodexStatus = (await existingMemberCodexAuth.json()).status;
  if (existingMemberCodexStatus === 'authenticated') {
    console.log(
      "ok - preserved the harness member's pre-existing Codex credential instead of overwriting it"
    );
  } else {
    // Persist only simulated, unusable token material. This exercises the exact
    // sandbox user home across replicas without contacting OpenAI or creating a
    // real device attempt; check-auth reads the same path a Codex executor uses.
    const dummyRefreshToken = `ha-refresh-${crypto.randomUUID()}`;
    const dummyAccessToken = `ha-access-${crypto.randomUUID()}`;
    const dummyIdToken = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'ha-simulated',
          chatgpt_account_id: 'ha-simulated-account',
        },
      })
    ).toString('base64url')}.signature`;
    const admittedCodexImport = await fetch(`${daemonA}/codex-auth/import`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        authJson: JSON.stringify({
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: dummyIdToken,
            access_token: dummyAccessToken,
            refresh_token: dummyRefreshToken,
            account_id: 'ha-simulated-account',
          },
          last_refresh: new Date().toISOString(),
        }),
      }),
    });
    assert.equal(admittedCodexImport.status, 201);
    const admittedCodexImportBody = await admittedCodexImport.json();
    assert.equal(admittedCodexImportBody.status, 'authenticated');
    cleanupCodexAccessToken = memberAccessToken;

    const inspectedThroughB = await fetch(`${daemonB}/check-auth`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool: 'codex', validateNative: true }),
    });
    assert.equal(inspectedThroughB.status, 201);
    assert.deepEqual(await inspectedThroughB.json(), {
      status: 'authenticated',
      authenticated: true,
      method: 'oauth',
      hint: 'ChatGPT login found (ha-simulated plan).',
    });

    const logoutThroughB = await fetch(`${daemonB}/codex-auth/logout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberAccessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(logoutThroughB.status, 201);
    cleanupCodexAccessToken = undefined;
    const inspectedAfterLogout = await fetch(`${daemonA}/check-auth`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${memberAccessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool: 'codex', validateNative: true }),
    });
    assert.equal(inspectedAfterLogout.status, 201);
    assert.equal((await inspectedAfterLogout.json()).status, 'unauthenticated');
    const authLogs = dockerOutput('logs', '--no-color', 'daemon-a', 'daemon-b', 'ingress');
    assert(!authLogs.includes(dummyRefreshToken), 'Codex refresh token appeared in HA logs');
    assert(!authLogs.includes(dummyAccessToken), 'Codex access token appeared in HA logs');
    console.log(
      'ok - Codex exact-user auth file is written on A, consumed on B, removed on B, and absent on A'
    );
  }

  // This fixed Compose-only identity is reserved for the destructive Claude
  // HA smoke. Reset any residue from an interrupted prior run so reusable
  // volumes cannot turn the required adversarial assertions into a skip.
  const resetClaudeRoute = await fetch(`${daemonA}/users/${claudeUserId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ filesystem_home: null }),
  });
  assert.equal(resetClaudeRoute.status, 200, await resetClaudeRoute.text());
  const resetClaudeProbe = await fetch(`${daemonB}/claude-auth/logout`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(resetClaudeProbe.status, 201);
  await resetClaudeProbe.text();

  const initialClaudeAuth = await fetch(`${daemonA}/check-auth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool: 'claude-code', validateNative: true }),
  });
  assert.equal(initialClaudeAuth.status, 201);
  assert.equal((await initialClaudeAuth.json()).status, 'unauthenticated');

  const startA = await fetch(`${daemonA}/claude-auth/oauth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(startA.status, 201);
  const attemptA = await startA.json();
  assert.equal(attemptA.phase, 'awaiting_code');
  assert.equal(typeof attemptA.attemptId, 'string');
  const statusThroughB = await fetch(
    `${daemonB}/claude-auth/oauth?attemptId=${encodeURIComponent(attemptA.attemptId)}`,
    { headers: { authorization: `Bearer ${claudeAccessToken}` } }
  );
  assert.equal(statusThroughB.status, 200);
  assert.deepEqual(await statusThroughB.json(), {
    phase: 'awaiting_code',
    attemptId: attemptA.attemptId,
    expiresAt: attemptA.expiresAt,
  });

  const wrongStateThroughB = await fetch(`${daemonB}/claude-auth/oauth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ attemptId: attemptA.attemptId, code: 'HA-CODE#wrong-state' }),
  });
  assert.equal(wrongStateThroughB.status, 400);
  await wrongStateThroughB.text();

  const [raceAResponse, raceBResponse] = await Promise.all(
    [daemonA, daemonB].map((base) =>
      fetch(`${base}/claude-auth/oauth`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${claudeAccessToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      })
    )
  );
  assert.equal(raceAResponse.status, 201);
  assert.equal(raceBResponse.status, 201);
  const [raceA, raceB] = await Promise.all([raceAResponse.json(), raceBResponse.json()]);
  const currentThroughA = await fetch(`${daemonA}/claude-auth/oauth`, {
    headers: { authorization: `Bearer ${claudeAccessToken}` },
  });
  assert.equal(currentThroughA.status, 200);
  const currentAttempt = await currentThroughA.json();
  assert([raceA.attemptId, raceB.attemptId].includes(currentAttempt.attemptId));

  assert.match(claudeTenantId, /^[A-Za-z0-9_-]+$/);
  assert.match(claudeUserId, /^[A-Za-z0-9_-]+$/);
  const claudeConfigDir = `/home/agor/.agor/tenants/${claudeTenantId}/homes/${claudeUserId}/.claude`;
  const claudeOwnerHome = claudeConfigDir.slice(0, -'/.claude'.length);
  const dummyClaudeAccess = `sk-ant-oat-ha-${crypto.randomUUID()}`;
  const dummyClaudeRefresh = `sk-ant-ort-ha-${crypto.randomUUID()}`;
  const credentialPayload = Buffer.from(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: dummyClaudeAccess,
        refreshToken: dummyClaudeRefresh,
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
        subscriptionType: null,
        rateLimitTier: null,
      },
    })
  ).toString('base64');
  dockerOutput(
    'exec',
    '-T',
    'daemon-a',
    'sh',
    '-c',
    `mkdir -p '${claudeConfigDir}' && printf '%s' '${credentialPayload}' | base64 -d > '${claudeConfigDir}/.credentials.json' && chmod 600 '${claudeConfigDir}/.credentials.json'`
  );
  const setManagedClaudeSource = () => {
    const update = dockerOutput(
      'exec',
      '-T',
      'postgres',
      'psql',
      '--set',
      'ON_ERROR_STOP=1',
      '--username',
      'agor_bootstrap',
      '--dbname',
      'agor',
      '--command',
      `UPDATE users SET data = COALESCE(data, '{}'::jsonb) || jsonb_build_object('agentic_credential_sources', COALESCE(data->'agentic_credential_sources', '{}'::jsonb) || '{"claude-code":"managed_file"}'::jsonb) WHERE tenant_id = '${claudeTenantId}' AND user_id = '${claudeUserId}'`
    );
    assert.match(update, /UPDATE 1/);
  };
  // Provider exchange is deliberately not invoked by this deterministic
  // smoke. Complete its trusted metadata half as a fixture so the runtime
  // exercises the explicit source model rather than legacy inference.
  setManagedClaudeSource();

  const fenceProbe = startClaudeContainmentProbe(
    'daemon-a',
    claudeOwnerHome,
    `ha-fence-${crypto.randomUUID()}`
  );
  await waitUntil(
    () => dockerFileExists('daemon-b', fenceProbe.ready),
    'live HA Claude containment fence probe',
    30_000
  );
  const beforeFence = claudeAuthoritySnapshot('daemon-a', claudeConfigDir);

  // An external Claude method choice uses the same user authority, invalidates
  // the winning attempt, and advances the exact home's tombstone through B
  // while A holds a live sandbox attacking every alias and authority leaf.
  const selectNative = await fetch(`${daemonB}/users/${claudeUserId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      agentic_auth_methods: { 'claude-code': 'subscription' },
      agentic_credential_sources: { 'claude-code': 'none' },
    }),
  });
  assert.equal(selectNative.status, 200);
  assert.equal((await selectNative.json()).agentic_credential_sources?.['claude-code'], 'none');
  const afterFence = claudeAuthoritySnapshot('daemon-b', claudeConfigDir);
  for (const leaf of Object.keys(beforeFence)) {
    assert.equal(afterFence[leaf].inode, beforeFence[leaf].inode, `${leaf} inode changed on fence`);
  }
  assert.equal(
    afterFence['.credentials.json'].sha256,
    beforeFence['.credentials.json'].sha256,
    'source fencing changed credential bytes'
  );
  assert.notEqual(
    afterFence['.agor-auth-generation'].sha256,
    beforeFence['.agor-auth-generation'].sha256,
    'source fencing did not advance the authority generation'
  );
  assert.equal(
    afterFence['.agor-auth-mutation.lock'].sha256,
    beforeFence['.agor-auth-mutation.lock'].sha256,
    'source fencing changed lock bytes'
  );
  dockerOutput('exec', '-T', 'daemon-b', 'touch', fenceProbe.proceed);
  await fenceProbe.completion;
  assert.deepEqual(
    claudeAuthoritySnapshot('daemon-a', claudeConfigDir),
    afterFence,
    'live alias/sidecar attacks changed authority after replica-B fencing'
  );
  cleanupClaudeAccessToken = claudeAccessToken;
  const afterExternalChoice = await fetch(`${daemonA}/claude-auth/oauth`, {
    headers: { authorization: `Bearer ${claudeAccessToken}` },
  });
  assert.equal(afterExternalChoice.status, 200);
  assert.equal((await afterExternalChoice.json()).phase, 'idle');

  setManagedClaudeSource();

  const visibleThroughB = await fetch(`${daemonB}/check-auth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool: 'claude-code', validateNative: true }),
  });
  assert.equal(visibleThroughB.status, 201);
  assert.deepEqual(await visibleThroughB.json(), {
    status: 'authenticated',
    authenticated: true,
    method: 'oauth',
    hint: 'Claude subscription login found.',
  });

  // A route-affecting users.patch on B must join the same tenant/user
  // authority as an attempt started on A, invalidate that attempt, and
  // generation-delete the old canonical credential before the users row
  // publishes the override. The checked-in HA profile intentionally refuses
  // to use the override as a native credential route.
  const routeRaceStart = await fetch(`${daemonA}/claude-auth/oauth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(routeRaceStart.status, 201);
  const routeRaceAttempt = await routeRaceStart.json();
  const temporaryOverride = `/home/agor/ha-route-retired-${crypto.randomUUID()}`;
  const routeChangeThroughB = await fetch(`${daemonB}/users/${claudeUserId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ filesystem_home: temporaryOverride }),
  });
  const routeChangeBody = await routeChangeThroughB.text();
  assert.equal(routeChangeThroughB.status, 200, routeChangeBody);
  const routeAttemptAfterPatch = await fetch(
    `${daemonA}/claude-auth/oauth?attemptId=${encodeURIComponent(routeRaceAttempt.attemptId)}`,
    { headers: { authorization: `Bearer ${claudeAccessToken}` } }
  );
  assert.equal(routeAttemptAfterPatch.status, 200);
  assert.equal((await routeAttemptAfterPatch.json()).phase, 'error');
  dockerOutput(
    'exec',
    '-T',
    'daemon-a',
    'sh',
    '-c',
    `test -f '${claudeConfigDir}/.credentials.json' && test ! -s '${claudeConfigDir}/.credentials.json'`
  );

  const restoreCanonicalThroughA = await fetch(`${daemonA}/users/${claudeUserId}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ filesystem_home: null }),
  });
  const restoreCanonicalBody = await restoreCanonicalThroughA.text();
  assert.equal(restoreCanonicalThroughA.status, 200, restoreCanonicalBody);
  dockerOutput(
    'exec',
    '-T',
    'daemon-b',
    'sh',
    '-c',
    `mkdir -p '${claudeConfigDir}' && printf '%s' '${credentialPayload}' | base64 -d > '${claudeConfigDir}/.credentials.json' && chmod 600 '${claudeConfigDir}/.credentials.json'`
  );

  const logoutProbe = startClaudeContainmentProbe(
    'daemon-a',
    claudeOwnerHome,
    `ha-logout-${crypto.randomUUID()}`
  );
  await waitUntil(
    () => dockerFileExists('daemon-b', logoutProbe.ready),
    'live HA Claude containment logout probe',
    30_000
  );
  const beforeLogout = claudeAuthoritySnapshot('daemon-a', claudeConfigDir);

  const logoutThroughB = await fetch(`${daemonB}/claude-auth/logout`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(logoutThroughB.status, 201);
  await logoutThroughB.text();
  const afterLogout = claudeAuthoritySnapshot('daemon-b', claudeConfigDir);
  for (const leaf of Object.keys(beforeLogout)) {
    assert.equal(
      afterLogout[leaf].inode,
      beforeLogout[leaf].inode,
      `${leaf} inode changed on logout`
    );
  }
  assert.equal(
    afterLogout['.credentials.json'].sha256,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'replica-B logout did not publish the empty credential tombstone'
  );
  assert.notEqual(
    afterLogout['.agor-auth-generation'].sha256,
    beforeLogout['.agor-auth-generation'].sha256,
    'replica-B logout did not advance the authority generation'
  );
  assert.equal(
    afterLogout['.agor-auth-mutation.lock'].sha256,
    beforeLogout['.agor-auth-mutation.lock'].sha256,
    'replica-B logout changed lock bytes'
  );
  dockerOutput('exec', '-T', 'daemon-b', 'touch', logoutProbe.proceed);
  await logoutProbe.completion;
  assert.deepEqual(
    claudeAuthoritySnapshot('daemon-a', claudeConfigDir),
    afterLogout,
    'live alias/sidecar attacks changed authority after replica-B logout'
  );
  cleanupClaudeAccessToken = undefined;
  const absentThroughA = await fetch(`${daemonA}/check-auth`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${claudeAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tool: 'claude-code', validateNative: true }),
  });
  assert.equal(absentThroughA.status, 201);
  assert.equal((await absentThroughA.json()).status, 'unauthenticated');
  const claudeAuthLogs = dockerOutput('logs', '--no-color', 'daemon-a', 'daemon-b', 'ingress');
  assert(!claudeAuthLogs.includes(dummyClaudeAccess), 'Claude access token appeared in HA logs');
  assert(!claudeAuthLogs.includes(dummyClaudeRefresh), 'Claude refresh token appeared in HA logs');
  console.log(
    'ok - Claude attempts start/replace across replicas; live every-alias parent/sidecar attacks cannot escape; extra writable-store topology fails closed; replica-B source fencing, route cleanup, and logout retain authority inodes and cross-replica ordering'
  );

  const ingressInstances = new Set();
  for (let attempt = 0; attempt < 12; attempt++) {
    const health = await authenticatedHealth(ingress, accessToken);
    ingressInstances.add(health.instance.label);
  }
  assert.deepEqual(ingressInstances, new Set(['daemon-a', 'daemon-b']));
  console.log('ok - ingress distributes ordinary authenticated HTTP across both daemons');

  const edgeRateLimitProbes = await Promise.all(
    Array.from({ length: 30 }, () =>
      fetch(`${ingress}/authentication`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          strategy: 'local',
          email: 'ha-edge-probe@example.invalid',
          password: 'deliberately-invalid-ha-probe',
        }),
      })
    )
  );
  assert(edgeRateLimitProbes.some((response) => response.status === 429));
  for (const response of edgeRateLimitProbes) {
    assert.equal(response.headers.get('x-agor-edge-rate-limit'), 'compose-per-ip');
    await response.text();
  }
  console.log('ok - sensitive auth traffic is throttled at the fleet-wide Compose ingress');

  const apiKeyCreate = await fetch(`${ingress}/api/v1/user/api-keys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `HA stateless MCP ${Date.now()}` }),
  });
  assert.equal(apiKeyCreate.status, 201, `personal API key create failed: ${apiKeyCreate.status}`);
  const apiKeyResult = await apiKeyCreate.json();
  if (typeof apiKeyResult.key?.id === 'string') cleanupApiKeyId = apiKeyResult.key.id;
  assert.equal(typeof apiKeyResult.rawKey, 'string');
  assert.equal(typeof apiKeyResult.key?.id, 'string');

  // A personal API key is intentionally opaque and therefore cannot select a
  // tenant in this auth-claim-only deployment. Prove both replicas and ingress
  // fail closed instead of performing a global key-table lookup or inferring
  // tenant scope from a caller-controlled value. Deployments that need
  // personal-key MCP access must provide reviewed trusted-edge tenant routing;
  // session MCP tokens already carry a signed tenant binding.
  for (const base of [daemonA, daemonB, ingress]) {
    const initialize = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': apiKeyResult.rawKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 200,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'agor-ha-harness', version: '1.0.0' },
        },
      }),
    });
    assert.equal(
      initialize.status,
      401,
      `personal API key unexpectedly selected a tenant at ${base}: ${initialize.status}`
    );
    assert.equal(initialize.headers.get('mcp-session-id'), null);
    assert.match(await initialize.text(), /tenant/i);
  }
  const apiKeyRemove = await fetch(`${ingress}/api/v1/user/api-keys/${apiKeyResult.key.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(apiKeyRemove.status, 200, `personal API key cleanup failed: ${apiKeyRemove.status}`);
  await apiKeyRemove.text();
  cleanupApiKeyId = undefined;
  console.log('ok - opaque personal API keys cannot select a tenant in auth-claim-only HA');

  await assertAnonymousHandshakeRejected(daemonB);
  const foreignSocket = await connectAuthenticated(daemonB, foreignAccessToken);
  const memberSocket = await connectAuthenticated(daemonB, memberAccessToken);
  cleanupSockets.add(foreignSocket);
  cleanupSockets.add(memberSocket);
  const health = await socketHealth(socketA);
  assert.equal(health.deployment.supportProfile, 'constrained-active-active');
  assert.equal(health.deployment.capabilities.taskExecution, true);
  assert.equal(health.deployment.capabilities.agorManagedInteractivePermissions, true);
  assert.equal(health.deployment.capabilities.mcpOAuth, true);
  assert.deepEqual(health.features.branchStorage, {
    defaultMode: 'clone',
    allowedModes: ['clone'],
    allowShallowClones: true,
  });
  console.log('ok - authenticated health exposes constrained support capabilities');
  const boardEvents = [];
  const foreignBoardEvents = [];
  const memberBoardEvents = [];
  socketB.on('boards created', (board) => boardEvents.push(board));
  foreignSocket.on('boards created', (board) => foreignBoardEvents.push(board));
  memberSocket.on('boards created', (board) => memberBoardEvents.push(board));
  const created = await fetch(`${daemonA}/boards`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `HA integration ${Date.now()}`,
      access_mode: 'private',
    }),
  });
  assert.equal(created.status, 201, `board create failed: ${created.status}`);
  const board = await created.json();
  assert.equal(board.access_mode, 'private', 'same-tenant RBAC checks require a private board');
  cleanupBoards.set(board.board_id, accessToken);
  await waitUntil(() => boardEvents.length > 0, 'cross-replica Feathers board event');
  await delay(EXACTLY_ONCE_SETTLE_MS);
  assert.deepEqual(
    boardEvents.map((value) => value.board_id),
    [board.board_id]
  );
  assert.deepEqual(foreignBoardEvents, []);
  assert.deepEqual(memberBoardEvents, []);
  console.log(
    'ok - authorized Feathers publication crossed replicas once in the observation window'
  );
  console.log('ok - unauthenticated Socket.IO handshakes fail before connection admission');
  console.log('ok - foreign-tenant socket received no Feathers publication');

  const foreignCreated = await fetch(`${daemonB}/boards`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${foreignAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: `Foreign HA integration ${Date.now()}` }),
  });
  assert.equal(foreignCreated.status, 201, `foreign board create failed: ${foreignCreated.status}`);
  const foreignBoard = await foreignCreated.json();
  cleanupBoards.set(foreignBoard.board_id, foreignAccessToken);
  await waitUntil(
    () => foreignBoardEvents.some((value) => value.board_id === foreignBoard.board_id),
    'same-tenant foreign board event'
  );
  assert.deepEqual(
    foreignBoardEvents.map((value) => value.board_id),
    [foreignBoard.board_id]
  );
  foreignBoardEvents.length = 0;
  const foreignRead = await fetch(`${daemonA}/boards/${foreignBoard.board_id}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const missingRead = await fetch(`${daemonA}/boards/018f0000-0000-7000-8000-000000000099`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(foreignRead.status, missingRead.status);
  assert.equal(foreignRead.status, 404);
  await Promise.all([foreignRead.text(), missingRead.text()]);
  const [foreignOwners, missingOwners] = await Promise.all([
    fetch(`${daemonA}/boards/${foreignBoard.board_id}/owners`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
    fetch(`${daemonA}/boards/018f0000-0000-7000-8000-000000000099/owners`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }),
  ]);
  assert.equal(foreignOwners.status, 403);
  assert.equal(foreignOwners.status, missingOwners.status);
  assert.equal(await foreignOwners.text(), await missingOwners.text());
  console.log('ok - exact foreign board IDs are indistinguishable from missing IDs');

  const watchBoard = (socket) =>
    new Promise((resolve) => socket.emit('presence:watch-board', board.board_id, resolve));
  const [watchA, watchB, foreignWatch, memberWatch] = await Promise.all([
    watchBoard(socketA),
    watchBoard(socketB),
    watchBoard(foreignSocket),
    watchBoard(memberSocket),
  ]);
  assert.deepEqual(watchA, { ok: true });
  assert.deepEqual(watchB, { ok: true });
  assert.deepEqual(foreignWatch, { ok: false });
  assert.deepEqual(memberWatch, { ok: false });
  let cursorCount = 0;
  let foreignCursorCount = 0;
  let memberCursorCount = 0;
  socketB.on('cursor-moved', () => cursorCount++);
  foreignSocket.on('cursor-moved', () => foreignCursorCount++);
  memberSocket.on('cursor-moved', () => memberCursorCount++);
  socketA.emit('cursor-move', { boardId: board.board_id, x: 1, y: 2, timestamp: Date.now() });
  await waitUntil(() => cursorCount > 0, 'cross-replica cursor event');
  await delay(EXACTLY_ONCE_SETTLE_MS);
  assert.equal(cursorCount, 1);
  assert.equal(foreignCursorCount, 0);
  assert.equal(memberCursorCount, 0);
  console.log(
    'ok - tenant-scoped direct room event crossed replicas once in the observation window'
  );
  console.log('ok - foreign-tenant native-room watcher received no cursor event');
  console.log('ok - same-tenant member without board access received no cursor event');

  const affinitySocket = io(ingress, {
    autoConnect: false,
    transports: ['polling', 'websocket'],
    reconnection: true,
    auth: socketAuthentication(currentBrowserAccessToken),
  });
  cleanupSockets.add(affinitySocket);
  const firstInfo = once(affinitySocket, 'server-info');
  const affinityConnected = once(affinitySocket, 'connect');
  affinitySocket.connect();
  await affinityConnected;
  await new Promise((resolve, reject) => {
    if (affinitySocket.io.engine.transport.name === 'websocket') return resolve();
    const timer = setTimeout(() => reject(new Error('polling transport did not upgrade')), 15_000);
    affinitySocket.io.engine.once('upgrade', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const initialServer = await firstInfo;
  assert(['daemon-a', 'daemon-b'].includes(initialServer.instanceId));
  console.log('ok - sticky polling session upgraded to WebSocket');

  const socketIdsBeforeRotation = [socketA.id, socketB.id, affinitySocket.id];
  const handshakesBeforeRotation = browserCredential.handshakeCount;
  const refreshed = await fetch(`${ingress}/authentication/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  assert.equal(refreshed.status, 201, `browser token refresh failed: ${refreshed.status}`);
  const refreshedTokens = await refreshed.json();
  assert.equal(typeof refreshedTokens.accessToken, 'string');
  assert.notEqual(refreshedTokens.accessToken, accessToken);
  browserCredential.accessToken = refreshedTokens.accessToken;
  await delay(EXACTLY_ONCE_SETTLE_MS);
  assert.deepEqual([socketA.id, socketB.id, affinitySocket.id], socketIdsBeforeRotation);
  assert.equal(browserCredential.handshakeCount, handshakesBeforeRotation);
  await Promise.all([socketHealth(socketA), socketHealth(socketB), socketHealth(affinitySocket)]);
  console.log('ok - browser access-token rotation leaves healthy immutable sockets connected');

  let recoveredBoard;
  if (process.env.AGOR_HA_INTEGRATION_FAILURES === '1') {
    const stopped = initialServer.instanceId;
    const survivor = stopped === 'daemon-a' ? 'daemon-b' : 'daemon-a';
    const handshakesBeforeFailure = browserCredential.handshakeCount;
    // An established WebSocket is not transparently moved by ingress. The
    // client can take up to the configured Engine.IO heartbeat window to detect
    // the dead transport before reconnecting through the surviving upstream.
    const reconnectedInfo = once(affinitySocket, 'server-info', 100_000);
    cleanupStoppedServices.add(stopped);
    docker('stop', stopped);
    const nextServer = await reconnectedInfo;
    assert.equal(nextServer.instanceId, survivor);
    assert(browserCredential.handshakeCount > handshakesBeforeFailure);
    const reconnectedSocketHealth = await socketHealth(affinitySocket);
    assert.equal(reconnectedSocketHealth.deployment.instanceId, survivor);
    await waitFor(`${ingress}/readyz`, (r) => r.status === 200);
    const survivorHealth = await authenticatedHealth(ingress, accessToken);
    assert.equal(survivorHealth.instance.label, survivor);
    startServiceOnly(stopped);
    cleanupStoppedServices.delete(stopped);
    await waitFor(`${stopped === 'daemon-a' ? daemonA : daemonB}/readyz`, (r) => r.status === 200);
    await waitUntil(
      () => socketA.connected && socketB.connected,
      'direct replica socket reconnect'
    );
    await Promise.all([socketHealth(socketA), socketHealth(socketB)]);
    const [rewatchA, rewatchB] = await Promise.all([watchBoard(socketA), watchBoard(socketB)]);
    assert.deepEqual(rewatchA, { ok: true });
    assert.deepEqual(rewatchB, { ok: true });
    console.log('ok - daemon kill/restart preserved new HTTP and Socket.IO reconnect');

    cleanupStoppedServices.add('redis');
    docker('stop', 'redis');
    await Promise.all([
      waitFor(`${daemonA}/readyz`, (r) => r.status === 503),
      waitFor(`${daemonB}/readyz`, (r) => r.status === 503),
      waitFor(`${daemonA}/livez`, (r) => r.status === 200),
      waitFor(`${daemonB}/livez`, (r) => r.status === 200),
    ]);
    const handshakesBeforeRedisOutage = browserCredential.handshakeCount;
    await waitUntil(
      () =>
        !socketA.connected &&
        !socketB.connected &&
        !affinitySocket.connected &&
        !foreignSocket.connected &&
        !memberSocket.connected,
      'Redis outage socket transport fence'
    );
    const cursorCountBeforeOutagePacket = cursorCount;
    // Presence samples are ephemeral. Volatile delivery proves an event
    // generated while the required fanout plane is unavailable is neither
    // accepted nor buffered by the client for post-recovery replay.
    socketA.volatile.emit('cursor-move', {
      boardId: board.board_id,
      x: 91,
      y: 92,
      timestamp: Date.now(),
    });
    await delay(EXACTLY_ONCE_SETTLE_MS);
    assert.equal(cursorCount, cursorCountBeforeOutagePacket);
    startServiceOnly('redis');
    cleanupStoppedServices.delete('redis');
    await Promise.all([
      waitFor(`${daemonA}/readyz`, (r) => r.status === 200),
      waitFor(`${daemonB}/readyz`, (r) => r.status === 200),
    ]);
    await waitUntil(
      () =>
        socketA.connected &&
        socketB.connected &&
        affinitySocket.connected &&
        foreignSocket.connected &&
        memberSocket.connected,
      'post-Redis-outage socket reconnect',
      30_000
    );
    assert(browserCredential.handshakeCount > handshakesBeforeRedisOutage);
    const [redisRewatchA, redisRewatchB] = await Promise.all([
      watchBoard(socketA),
      watchBoard(socketB),
    ]);
    assert.deepEqual(redisRewatchA, { ok: true });
    assert.deepEqual(redisRewatchB, { ok: true });
    await delay(EXACTLY_ONCE_SETTLE_MS);
    assert.equal(
      cursorCount,
      cursorCountBeforeOutagePacket,
      'native packet emitted during Redis outage was replayed after recovery'
    );
    socketA.emit('cursor-move', {
      boardId: board.board_id,
      x: 93,
      y: 94,
      timestamp: Date.now(),
    });
    await waitUntil(
      () => cursorCount === cursorCountBeforeOutagePacket + 1,
      'fresh post-recovery cursor event'
    );
    const recoveredEvents = [];
    socketB.on('boards created', (value) => recoveredEvents.push(value));
    const recoveredCreate = await fetch(`${daemonA}/boards`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `HA Redis recovery ${Date.now()}` }),
    });
    assert.equal(recoveredCreate.status, 201);
    recoveredBoard = await recoveredCreate.json();
    cleanupBoards.set(recoveredBoard.board_id, accessToken);
    await waitUntil(() => recoveredEvents.length > 0, 'post-recovery Feathers board event');
    await delay(EXACTLY_ONCE_SETTLE_MS);
    assert.deepEqual(
      recoveredEvents.map((value) => value.board_id),
      [recoveredBoard.board_id]
    );
    console.log(
      'ok - Redis outage fenced sockets, reauthenticated reconnects, dropped gap traffic without replay, and recovered fanout'
    );
  }

  assert.deepEqual(foreignBoardEvents, []);
  foreignBoardEvents.length = 0;
  memberBoardEvents.length = 0;
  const tenantSocketIdsBeforeGrant = [socketA.id, socketB.id, memberSocket.id, affinitySocket.id];
  const addOwner = await fetch(`${daemonA}/boards/${board.board_id}/owners`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: memberUserId }),
  });
  assert.equal(addOwner.status, 201, `board owner grant failed: ${addOwner.status}`);
  await addOwner.text();
  await delay(EXACTLY_ONCE_SETTLE_MS);
  assert.deepEqual(
    [socketA.id, socketB.id, memberSocket.id, affinitySocket.id],
    tenantSocketIdsBeforeGrant
  );
  assert(
    socketA.connected && socketB.connected && memberSocket.connected && affinitySocket.connected
  );
  assert.deepEqual(await watchBoard(memberSocket), { ok: true });
  console.log('ok - additive owner grant clears remote ACL cache without disconnecting sockets');

  const tenantDisconnects = [socketA, socketB, memberSocket, affinitySocket].map((socket) =>
    once(socket, 'disconnect')
  );
  const removeOwner = await fetch(`${daemonA}/boards/${board.board_id}/owners/${memberUserId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(removeOwner.status, 200, `board owner revocation failed: ${removeOwner.status}`);
  await removeOwner.text();
  await Promise.all(tenantDisconnects);
  assert.equal(foreignSocket.connected, true);
  assert.equal(memberSocket.connected, false);

  const memberReconnected = once(memberSocket, 'connect');
  memberSocket.connect();
  await memberReconnected;
  assert.deepEqual(await watchBoard(memberSocket), { ok: false });
  assert.deepEqual(foreignBoardEvents, []);
  assert.deepEqual(memberBoardEvents, []);
  console.log(
    'ok - owner revocation evicts tenant sockets across replicas and reconnect cannot restore access'
  );

  completed = true;
} catch (error) {
  // Preserve the test/assertion error even when one or more best-effort cleanup
  // operations also fail. Cleanup failures fail an otherwise-successful run.
  primaryError = error;
} finally {
  for (const probe of cleanupDockerProcesses) {
    try {
      spawnSync('docker', [...compose, 'exec', '-T', probe.service, 'touch', probe.proceed], {
        env: process.env,
        stdio: 'ignore',
      });
      await Promise.race([probe.completion, delay(2_000)]);
      if (probe.child.exitCode === null) probe.child.kill('SIGTERM');
    } catch (error) {
      probe.child.kill('SIGTERM');
      cleanupWarning(`Claude containment probe cleanup failed for ${probe.service}`, error);
    }
  }
  cleanupDockerProcesses.clear();

  for (const socket of cleanupSockets) {
    try {
      socket.close();
    } catch (error) {
      cleanupWarning('socket close failed', error);
    }
  }

  // A failed assertion may occur while a dependency or replica is stopped.
  // Restore the branch-only stack before attempting authenticated cleanup.
  if (cleanupStoppedServices.size > 0) {
    for (const service of cleanupStoppedServices) startServiceOnlyBestEffort(service);
    cleanupStoppedServices.clear();
  }
  await Promise.all(
    [daemonA, daemonB, ingress].map((base) =>
      waitFor(`${base}/readyz`, (response) => response.status === 200, 90_000).catch((error) =>
        cleanupWarning(`readiness restoration failed for ${base}`, error)
      )
    )
  );

  if (cleanupAccessToken && cleanupApiKeyId) {
    try {
      const removed = await fetch(`${ingress}/api/v1/user/api-keys/${cleanupApiKeyId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${cleanupAccessToken}` },
      });
      if (removed.status !== 200 && removed.status !== 404) {
        cleanupWarning(`API key removal returned ${removed.status}`);
      }
      await removed.text();
    } catch (error) {
      cleanupWarning('API key removal failed', error);
    }
  }

  if (cleanupCodexAccessToken) {
    try {
      const removed = await fetch(`${ingress}/codex-auth/logout`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cleanupCodexAccessToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (removed.status !== 201) cleanupWarning(`Codex auth cleanup returned ${removed.status}`);
      await removed.text();
    } catch (error) {
      cleanupWarning('Codex auth cleanup failed', error);
    }
  }

  if (cleanupClaudeAccessToken) {
    try {
      const removed = await fetch(`${ingress}/claude-auth/logout`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cleanupClaudeAccessToken}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (removed.status !== 201) cleanupWarning(`Claude auth cleanup returned ${removed.status}`);
      await removed.text();
    } catch (error) {
      cleanupWarning('Claude auth cleanup failed', error);
    }
  }

  if (cleanupAccessToken) {
    for (const [boardId, ownerAccessToken] of cleanupBoards) {
      try {
        const removed = await fetch(`${ingress}/boards/${boardId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${ownerAccessToken}` },
        });
        if (removed.status !== 200 && removed.status !== 404) {
          cleanupWarning(`board ${boardId} removal returned ${removed.status}`);
        }
        await removed.text();
      } catch (error) {
        cleanupWarning(`board ${boardId} removal failed`, error);
      }
    }
  }
}

if (primaryError) throw primaryError;
if (cleanupFailures.length > 0) {
  throw new AggregateError(cleanupFailures, 'daemon HA integration cleanup did not complete');
}
if (completed) console.log('PASS: daemon HA Docker integration');
