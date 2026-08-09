#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { io } from 'socket.io-client';

if (process.env.AGOR_HA_INTEGRATION !== '1') {
  console.log('SKIP: set AGOR_HA_INTEGRATION=1 to exercise the branch HA Compose stack');
  process.exit(0);
}

for (const name of [
  'AGOR_REDIS_KEY_PREFIX',
  'AGOR_JWT_SECRET',
  'AGOR_MASTER_SECRET',
  'AGOR_ADMIN_PASSWORD',
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
const latestSocketAuthentication = new WeakMap();

function once(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function authenticateSocket(socket, accessToken) {
  return new Promise((resolve, reject) => {
    socket.emit(
      'create',
      'authentication',
      { strategy: 'jwt', accessToken },
      {},
      (error, result) =>
        error ? reject(new Error(error.message ?? String(error))) : resolve(result)
    );
  });
}

async function connectAuthenticated(url, accessToken) {
  const socket = io(url, {
    // Direct replica sockets isolate Redis/Feathers fanout from ingress
    // affinity. The separate ingress probe below deliberately exercises the
    // polling -> WebSocket upgrade path.
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 250,
  });
  // Feathers authentication/channel membership is process-local connection
  // state. Re-establish it after every transport reconnect.
  let initialAuthentication;
  socket.on('connect', () => {
    const attempt = authenticateSocket(socket, accessToken);
    latestSocketAuthentication.set(socket, attempt);
    initialAuthentication ??= attempt;
    void attempt.catch((error) => socket.emit('error', error));
  });
  await once(socket, 'connect');
  await initialAuthentication;
  return socket;
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
const cleanupBoardIds = new Set();
const cleanupSockets = new Set();
const cleanupStoppedServices = new Set();
let completed = false;
let primaryError;

try {
  if (process.env.AGOR_HA_INTEGRATION_START === '1') docker('up', '-d', '--build');

  await Promise.all(
    [ingress, daemonA, daemonB].map((base) => waitFor(`${base}/readyz`, (r) => r.status === 200))
  );
  console.log('ok - two daemons and ingress are ready');

  for (const service of ['daemon-a', 'daemon-b']) {
    const destinations = serviceMountDestinations(service);
    assert(destinations.has('/home/agor'), `${service} is missing the shared executor home mount`);
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
  console.log('ok - executor home and stable Agor workspace mounts are shared across replicas');

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
    assert.match(
      startupLogs,
      /Environment health monitor disabled by constrained HA support profile/
    );
    assert.doesNotMatch(startupLogs, /Health Monitor initialized/);
    assert.match(startupLogs, /Task runtime reconciler started .*policy: shared_postgres/);
    assert.match(startupLogs, /\[distributed-work\.task-queue\] event="loop_started"/);
  }
  console.log('ok - neither HA replica constructed/started the unfenced environment monitor');
  console.log('ok - both replicas activated shared runtime reconciliation and queue discovery');

  async function loginAdmin() {
    const response = await fetch(`${daemonA}/authentication`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        strategy: 'local',
        email: 'admin@agor.live',
        password: process.env.AGOR_ADMIN_PASSWORD,
      }),
    });
    assert.equal(response.status, 201, `admin login failed: ${response.status}`);
    return response.json();
  }

  let loginResult = await loginAdmin();
  if (loginResult.user?.must_change_password) {
    const confirmationSocket = await connectAuthenticated(daemonA, loginResult.accessToken);
    cleanupSockets.add(confirmationSocket);
    await new Promise((resolve, reject) => {
      confirmationSocket.emit(
        'patch',
        'users',
        loginResult.user.user_id,
        { password: process.env.AGOR_ADMIN_PASSWORD },
        {},
        (error, result) =>
          error ? reject(new Error(error.message ?? String(error))) : resolve(result)
      );
    });
    confirmationSocket.close();
    cleanupSockets.delete(confirmationSocket);
    loginResult = await loginAdmin();
  }
  const { accessToken } = loginResult;
  assert.equal(typeof accessToken, 'string');
  cleanupAccessToken = accessToken;

  const socketA = await connectAuthenticated(daemonA, accessToken);
  const socketB = await connectAuthenticated(daemonB, accessToken);
  cleanupSockets.add(socketA);
  cleanupSockets.add(socketB);
  const [healthA, healthB] = await Promise.all([socketHealth(socketA), socketHealth(socketB)]);
  assert.equal(healthA.deployment.instanceId, 'daemon-a');
  assert.equal(healthB.deployment.instanceId, 'daemon-b');
  assert.notEqual(healthA.deployment.bootId, healthB.deployment.bootId);
  for (const health of [healthA, healthB]) {
    assert.equal(health.deployment.supportProfile, 'constrained-active-active');
    assert.equal(health.deployment.capabilities.taskExecution, true);
    assert.equal(health.deployment.capabilities.executorTokenAuthority, true);
    assert.equal(health.deployment.capabilities.interactivePermissions, false);
    assert.equal(health.deployment.capabilities.scheduler, true);
    assert.equal(health.deployment.capabilities.sessionQueue, true);
    assert.equal(health.deployment.capabilities.taskRuntimeReconciliation, true);
    assert.equal(health.deployment.capabilities.knowledgeEmbeddingIndexer, true);
    assert.equal(health.deployment.capabilities.statelessMcp, true);
    assert.equal(health.deployment.capabilities.statefulMcp, false);
    assert.equal(health.deployment.capabilities.completionCallbackDurableAdmission, true);
    assert.equal(health.deployment.capabilities.completionCallbackPreAdmissionRecovery, false);
    assert.equal(health.deployment.capabilities.widgetResolutionDurableClaim, true);
    assert.equal(health.deployment.capabilities.gatewayListeners, true);
    assert.equal(health.deployment.capabilities.gatewayOutboundExactlyOnce, false);
    assert.equal(health.deployment.capabilities.environmentHealthMonitor, false);
    assert.equal(health.deployment.capabilities.codexCredentialFiles, true);
    assert.equal(health.deployment.capabilities.codexDeviceAuth, false);
    assert.equal(health.deployment.realtime.ready, true);
  }
  console.log(
    'ok - distinct daemon/boot identities expose the constrained merged-foundation profile'
  );

  const rejectedCodexDeviceAuth = await fetch(`${ingress}/codex-auth/device`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(rejectedCodexDeviceAuth.status, 503);
  const rejectedCodexDeviceBody = await rejectedCodexDeviceAuth.json();
  assert.equal(rejectedCodexDeviceBody.data?.feature, 'codexDeviceAuth');

  // A deliberately empty document proves that import reached validation
  // instead of the HA feature gate without writing a credential.
  const admittedCodexImport = await fetch(`${ingress}/codex-auth/import`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ authJson: '{}' }),
  });
  assert.equal(admittedCodexImport.status, 400);
  const admittedCodexImportBody = await admittedCodexImport.json();
  assert.notEqual(admittedCodexImportBody.data?.code, 'HA_FEATURE_UNSUPPORTED');
  console.log('ok - consistent-home Codex import is admitted while device polling stays gated');

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

  for (let attempt = 0; attempt < 4; attempt++) {
    const initialize = await fetch(`${ingress}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-API-Key': apiKeyResult.rawKey,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 200 + attempt,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'agor-ha-harness', version: '1.0.0' },
        },
      }),
    });
    assert.equal(initialize.status, 200, `stateless MCP initialize failed: ${initialize.status}`);
    assert.equal(initialize.headers.get('mcp-session-id'), null);
    assert.match(await initialize.text(), /protocolVersion/);
  }
  const rejectedStatefulMcp = await fetch(`${ingress}/mcp`, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKeyResult.rawKey,
      'Mcp-Session-Id': 'process-affine-session',
    },
  });
  assert.equal(rejectedStatefulMcp.status, 503);
  assert.match(JSON.stringify(await rejectedStatefulMcp.json()), /constrained-active-active/);
  const apiKeyRemove = await fetch(`${ingress}/api/v1/user/api-keys/${apiKeyResult.key.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(apiKeyRemove.status, 200, `personal API key cleanup failed: ${apiKeyRemove.status}`);
  await apiKeyRemove.text();
  cleanupApiKeyId = undefined;
  console.log('ok - stateless MCP crosses load-balanced ingress; stateful transport fails closed');

  const anonymousSocket = io(daemonB, { transports: ['websocket'], reconnection: false });
  cleanupSockets.add(anonymousSocket);
  await once(anonymousSocket, 'connect');
  const health = await socketHealth(socketA);
  assert.equal(health.deployment.supportProfile, 'constrained-active-active');
  assert.equal(health.deployment.capabilities.taskExecution, true);
  assert.equal(health.deployment.capabilities.interactivePermissions, false);
  console.log('ok - authenticated health exposes constrained support capabilities');
  const boardEvents = [];
  const anonymousBoardEvents = [];
  socketB.on('boards created', (board) => boardEvents.push(board));
  anonymousSocket.on('boards created', (board) => anonymousBoardEvents.push(board));
  const created = await fetch(`${daemonA}/boards`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `HA integration ${Date.now()}` }),
  });
  assert.equal(created.status, 201, `board create failed: ${created.status}`);
  const board = await created.json();
  cleanupBoardIds.add(board.board_id);
  await waitUntil(() => boardEvents.length > 0, 'cross-replica Feathers board event');
  await delay(EXACTLY_ONCE_SETTLE_MS);
  assert.deepEqual(
    boardEvents.map((value) => value.board_id),
    [board.board_id]
  );
  assert.deepEqual(anonymousBoardEvents, []);
  console.log(
    'ok - authorized Feathers publication crossed replicas once in the observation window'
  );
  console.log('ok - unauthenticated socket received no Feathers publication');

  const watchBoard = (socket) =>
    new Promise((resolve) => socket.emit('presence:watch-board', board.board_id, resolve));
  const [watchA, watchB, anonymousWatch] = await Promise.all([
    watchBoard(socketA),
    watchBoard(socketB),
    watchBoard(anonymousSocket),
  ]);
  assert.deepEqual(watchA, { ok: true });
  assert.deepEqual(watchB, { ok: true });
  assert.deepEqual(anonymousWatch, { ok: false });
  let cursorCount = 0;
  let anonymousCursorCount = 0;
  socketB.on('cursor-moved', () => cursorCount++);
  anonymousSocket.on('cursor-moved', () => anonymousCursorCount++);
  socketA.emit('cursor-move', { boardId: board.board_id, x: 1, y: 2, timestamp: Date.now() });
  await waitUntil(() => cursorCount > 0, 'cross-replica cursor event');
  await delay(EXACTLY_ONCE_SETTLE_MS);
  assert.equal(cursorCount, 1);
  assert.equal(anonymousCursorCount, 0);
  console.log(
    'ok - tenant-scoped direct room event crossed replicas once in the observation window'
  );
  console.log('ok - unauthorized native-room watcher received no cursor event');

  const affinitySocket = io(ingress, { transports: ['polling', 'websocket'], reconnection: true });
  cleanupSockets.add(affinitySocket);
  const firstInfo = once(affinitySocket, 'server-info');
  await once(affinitySocket, 'connect');
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
  let affinityAuthentication = authenticateSocket(affinitySocket, accessToken);
  await affinityAuthentication;
  affinitySocket.on('connect', () => {
    affinityAuthentication = authenticateSocket(affinitySocket, accessToken);
    void affinityAuthentication.catch((error) => affinitySocket.emit('error', error));
  });
  console.log('ok - sticky polling session upgraded to WebSocket');

  let recoveredBoard;
  if (process.env.AGOR_HA_INTEGRATION_FAILURES === '1') {
    const stopped = initialServer.instanceId;
    const survivor = stopped === 'daemon-a' ? 'daemon-b' : 'daemon-a';
    // An established WebSocket is not transparently moved by ingress. The
    // client can take up to the configured Engine.IO heartbeat window to detect
    // the dead transport before reconnecting through the surviving upstream.
    const reconnectedInfo = once(affinitySocket, 'server-info', 100_000);
    cleanupStoppedServices.add(stopped);
    docker('stop', stopped);
    const nextServer = await reconnectedInfo;
    assert.equal(nextServer.instanceId, survivor);
    await affinityAuthentication;
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
    await Promise.all([socketA, socketB].map((socket) => latestSocketAuthentication.get(socket)));
    await Promise.all([socketHealth(socketA), socketHealth(socketB)]);
    console.log('ok - daemon kill/restart preserved new HTTP and Socket.IO reconnect');

    cleanupStoppedServices.add('redis');
    docker('stop', 'redis');
    await Promise.all([
      waitFor(`${daemonA}/readyz`, (r) => r.status === 503),
      waitFor(`${daemonB}/readyz`, (r) => r.status === 503),
      waitFor(`${daemonA}/livez`, (r) => r.status === 200),
      waitFor(`${daemonB}/livez`, (r) => r.status === 200),
    ]);
    startServiceOnly('redis');
    cleanupStoppedServices.delete('redis');
    await Promise.all([
      waitFor(`${daemonA}/readyz`, (r) => r.status === 200),
      waitFor(`${daemonB}/readyz`, (r) => r.status === 200),
    ]);
    const recoveredEvents = [];
    socketB.on('boards created', (value) => recoveredEvents.push(value));
    const recoveredCreate = await fetch(`${daemonA}/boards`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `HA Redis recovery ${Date.now()}` }),
    });
    assert.equal(recoveredCreate.status, 201);
    recoveredBoard = await recoveredCreate.json();
    cleanupBoardIds.add(recoveredBoard.board_id);
    await waitUntil(() => recoveredEvents.length > 0, 'post-recovery Feathers board event');
    await delay(EXACTLY_ONCE_SETTLE_MS);
    assert.deepEqual(
      recoveredEvents.map((value) => value.board_id),
      [recoveredBoard.board_id]
    );
    console.log('ok - Redis outage failed readiness but preserved liveness, then recovered fanout');
  }

  completed = true;
} catch (error) {
  // Preserve the test/assertion error even when one or more best-effort cleanup
  // operations also fail. Cleanup failures fail an otherwise-successful run.
  primaryError = error;
} finally {
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

  if (cleanupAccessToken) {
    for (const boardId of cleanupBoardIds) {
      try {
        const removed = await fetch(`${ingress}/boards/${boardId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${cleanupAccessToken}` },
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
