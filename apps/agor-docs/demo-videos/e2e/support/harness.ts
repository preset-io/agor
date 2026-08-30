// Spins up a fully isolated, real Agor daemon + UI for the E2E demo-flow
// suite ("the syllabus"): a scratch SQLite DB, a scratch git data home, and
// dedicated ports — entirely separate from the developer's real ~/.agor and
// real daemon. Never touches the real deployment.
//
// FROM ZERO, every run: the scratch dir is wiped and the DB is only
// migrated — no fixture seeding. The daemon's own first-run bootstrap
// creates the development default admin (admin@agor.live / admin, gated by
// NODE_ENV=development + AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN=true +
// AGOR_ADMIN_PASSWORD=admin), and the ordered lessons in tests/flow/ then
// onboard that empty workspace step by step — repo, board, AI credential,
// branch, session — each lesson recording one training-ready snippet and
// leaving the state the next lesson starts from.
//
// Login is deliberately NOT part of any recording: global-setup signs in
// once over REST and mints a Playwright storageState (the UI keeps its JWT
// in localStorage), so every video opens on a signed-in UI.
//
// Set AGOR_E2E_KEEP_SCRATCH=1 to skip the wipe for faster iteration on a
// single later lesson (the earlier lessons' state must already exist).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = apps/agor-docs/demo-videos/e2e/support -> repo root is 5 levels up.
export const REPO_ROOT = path.resolve(HERE, '../../../../..');
export const SCRATCH_DIR = path.join(REPO_ROOT, '.e2e-runtime');
export const DB_PATH = path.join(SCRATCH_DIR, 'agor-e2e.db');
export const DATA_HOME = path.join(SCRATCH_DIR, 'data');
export const STATE_FILE = path.join(SCRATCH_DIR, 'harness-state.json');
export const STORAGE_STATE_PATH = path.join(SCRATCH_DIR, 'auth-state.json');
// Deliberately OUTSIDE SCRATCH_DIR (which the reset wipes): user-provided
// secrets, and the cached mirror of the demo repo (one network fetch ever).
export const SECRETS_DIR = path.join(REPO_ROOT, '.e2e-secrets');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.env');
export const CACHE_DIR = path.join(REPO_ROOT, '.e2e-cache');

// The demo project the syllabus onboards: preset-io/donut-shop — a fake
// business (storefront + back office + MotherDuck backend) built to power
// Agor demos. Mirrored once into .e2e-cache, then a fresh working clone is
// cut into the scratch dir every run, so agent sessions can freely modify it
// and the next run starts clean.
export const DEMO_REPO_URL = 'https://github.com/preset-io/donut-shop';
export const DEMO_REPO_MIRROR = path.join(CACHE_DIR, 'donut-shop.git');
export const DEMO_REPO_PATH = path.join(SCRATCH_DIR, 'projects', 'donut-shop');
export const DEMO_REPO_DEFAULT_BRANCH = 'master';

// The teammate framework repo (preset-io/agor-teammate). The onboarding
// wizard auto-clones this from GitHub the moment it mounts without it
// (useEnsureFrameworkRepo) — a network fetch inside a recording, re-fired
// on every load while onboarding is incomplete. The harness pre-registers
// a clone from the local mirror instead, so the wizard finds it by slug and
// never reaches for the network.
export const FRAMEWORK_REPO_URL = 'https://github.com/preset-io/agor-teammate.git';
export const FRAMEWORK_REPO_SLUG = 'preset-io/agor-teammate';
export const FRAMEWORK_REPO_MIRROR = path.join(CACHE_DIR, 'agor-teammate.git');
export const FRAMEWORK_REPO_PATH = path.join(DATA_HOME, 'repos', 'preset-io', 'agor-teammate');

export const DAEMON_PORT = 3131;
export const UI_PORT = 5199;
export const PROXY_PORT = 8899;
export const BASE_URL = `http://localhost:${UI_PORT}`;
export const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;
export const PROXY_URL = `http://localhost:${PROXY_PORT}`;
export const DATABASE_URL = `file:${DB_PATH}`;

// The development default admin the daemon bootstraps on first run
// (packages/core/src/db/user-utils.ts DEVELOPMENT_DEFAULT_ADMIN_USER).
export const ADMIN_USER = { email: 'admin@agor.live', password: 'admin' } as const;

// The board the onboarding wizard creates for the admin in lesson 00
// ("Admin's board" -> slug). Later lessons open it directly — the reel
// starts each lesson where its activity starts, not on the Home screen.
export const BOARD_PATH = '/b/admin-s-board/';

// Committed (not gitignored): recorded cassettes are what makes replay mode
// work without live credentials or network — see cassette-proxy.ts. One
// cassette covers the whole flow run: replay matching is per-(method + path)
// in recorded order, and the lessons run in a fixed order, so multiple
// agent-using lessons still line up.
export const CASSETTES_DIR = path.join(HERE, '../cassettes');
export const CASSETTE_NAME = process.env.AGOR_E2E_CASSETTE_NAME ?? 'flow';
export const CASSETTE_PATH = path.join(CASSETTES_DIR, `${CASSETTE_NAME}.json`);

/** 'live' | 'replay' | null (no real agent call in this run — agent lessons skip). */
export type AgentMode = 'live' | 'replay' | null;
export function resolveAgentMode(): AgentMode {
  const raw = process.env.AGOR_E2E_AGENT_MODE;
  return raw === 'live' || raw === 'replay' ? raw : null;
}

interface HarnessState {
  daemonPid: number;
  uiPid: number;
  proxyPid?: number;
}

/** Parse a KEY=VALUE-per-line env file. Missing file = no extra secrets (fine for UI/DB-only runs). */
function loadSecrets(): Record<string, string> {
  if (!existsSync(SECRETS_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(SECRETS_FILE, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(' ')}`);
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url} to become healthy: ${String(lastError)}`);
}

/**
 * Materialize the demo repo: mirror-clone once into the cache (the only
 * network fetch, using ambient git credentials — donut-shop is private),
 * then cut a fresh working clone into the scratch dir. Local-file clone, so
 * every run after the first is offline.
 */
function materializeClone(url: string, mirror: string, dest: string, label: string): void {
  if (!existsSync(mirror)) {
    console.log(`[harness] mirroring ${url} into ${mirror} (one-time)...`);
    mkdirSync(CACHE_DIR, { recursive: true });
    run('git', ['clone', '--mirror', url, mirror], REPO_ROOT, process.env);
  }
  if (existsSync(dest)) return;
  console.log(`[harness] cutting a fresh ${label} working clone...`);
  mkdirSync(path.dirname(dest), { recursive: true });
  run('git', ['clone', mirror, dest], REPO_ROOT, process.env);
  const git = (args: string[]) => run('git', args, dest, process.env);
  git(['config', 'user.email', 'e2e@agor.live']);
  git(['config', 'user.name', 'Agor E2E']);
}

/**
 * Register the teammate framework clone with the daemon (POST /repos/local —
 * the same "point Agor at an existing clone" path the CLI uses) so the
 * onboarding wizard's useFrameworkRepo slug lookup finds it and its
 * auto-clone-from-GitHub never fires during a recorded lesson.
 */
async function registerFrameworkRepo(accessToken: string): Promise<void> {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
  };
  const existing = await fetch(
    `${DAEMON_URL}/repos?slug=${encodeURIComponent(FRAMEWORK_REPO_SLUG)}`,
    {
      headers,
    }
  );
  if (existing.ok) {
    const rows = (await existing.json()) as { data?: unknown[] } | unknown[];
    const list = Array.isArray(rows) ? rows : (rows.data ?? []);
    if (list.length > 0) return;
  }
  console.log('[harness] registering the teammate framework repo from the local mirror...');
  const res = await fetch(`${DAEMON_URL}/repos/local`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: FRAMEWORK_REPO_PATH, slug: FRAMEWORK_REPO_SLUG }),
  });
  if (!res.ok) {
    throw new Error(
      `[harness] framework repo registration failed (${res.status}): ${await res.text()}`
    );
  }
}

/**
 * Sign in over REST, mint a Playwright storageState (so recordings never
 * include the login form — the UI reads its session from these two
 * localStorage keys, apps/agor-ui/src/utils/tokenRefresh.ts), and return
 * the access token for further setup calls.
 */
async function writeStorageState(): Promise<string> {
  const res = await fetch(`${DAEMON_URL}/authentication`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategy: 'local', ...ADMIN_USER }),
  });
  if (!res.ok) {
    throw new Error(`[harness] admin login failed (${res.status}): ${await res.text()}`);
  }
  const auth = (await res.json()) as { accessToken?: string; refreshToken?: string };
  if (!auth.accessToken) {
    throw new Error('[harness] admin login returned no accessToken');
  }
  const entries = [{ name: 'agor-access-token', value: auth.accessToken }];
  if (auth.refreshToken) entries.push({ name: 'agor-refresh-token', value: auth.refreshToken });
  writeFileSync(
    STORAGE_STATE_PATH,
    JSON.stringify({ cookies: [], origins: [{ origin: BASE_URL, localStorage: entries }] }, null, 2)
  );
  return auth.accessToken;
}

/**
 * Kill anything still listening on the suite's dedicated ports. An aborted
 * run can orphan its daemon/vite/proxy (teardown never fires on SIGKILL),
 * and a stale daemon on 3131 is worse than a crash: the new daemon dies on
 * EADDRINUSE while the old one keeps answering with last run's database —
 * every lesson then records against polluted state.
 */
function reapStalePorts(): void {
  for (const port of [DAEMON_PORT, UI_PORT, PROXY_PORT]) {
    let pids = '';
    try {
      pids = execFileSync('lsof', ['-ti', `:${port}`])
        .toString()
        .trim();
    } catch {
      continue; // lsof exits non-zero when the port is free
    }
    for (const pid of pids.split('\n').filter(Boolean)) {
      console.warn(`[harness] port ${port} held by stale pid ${pid} from a previous run — killing`);
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/** Global setup: reset scratch env from zero, spawn daemon + UI, mint auth state. */
export async function setupHarness(): Promise<void> {
  const keepScratch = process.env.AGOR_E2E_KEEP_SCRATCH === '1';
  const secrets = loadSecrets();
  const agentMode = resolveAgentMode();

  reapStalePorts();

  if (!keepScratch || !existsSync(DB_PATH)) {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    mkdirSync(DATA_HOME, { recursive: true });

    const dbEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL };
    console.log('[harness] migrating scratch database (no seed — the flow starts from zero)...');
    run('pnpm', ['agor', 'db', 'migrate', '-y'], REPO_ROOT, dbEnv);
  } else {
    console.log('[harness] AGOR_E2E_KEEP_SCRATCH=1 and scratch DB exists — skipping reset.');
  }

  materializeClone(DEMO_REPO_URL, DEMO_REPO_MIRROR, DEMO_REPO_PATH, 'donut-shop');
  materializeClone(FRAMEWORK_REPO_URL, FRAMEWORK_REPO_MIRROR, FRAMEWORK_REPO_PATH, 'agor-teammate');

  // Real agentic-tool keys (CLAUDE_CODE_OAUTH_TOKEN / OPENAI_API_KEY / ...)
  // read from the gitignored secrets file, never from the shell directly —
  // see .e2e-secrets/secrets.env (untracked, mode 0600).
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...secrets,
    DATABASE_URL,
    AGOR_DATA_HOME: DATA_HOME,
    PORT: String(DAEMON_PORT),
    NODE_ENV: 'development',
    CORS_ORIGIN: BASE_URL,
    // Three explicit gates for the fixed development admin (admin@agor.live /
    // admin, no forced password change) — user-utils.ts refuses without all
    // three, and the daemon never exposes this path outside development.
    AGOR_ALLOW_DEVELOPMENT_DEFAULT_ADMIN: 'true',
    AGOR_ADMIN_PASSWORD: ADMIN_USER.password,
  };
  console.log(`[harness] starting daemon on :${DAEMON_PORT}...`);
  const daemonLog = logFd(path.join(SCRATCH_DIR, 'daemon.log'));
  const daemon = spawn('npx tsx src/main.ts', {
    cwd: path.join(REPO_ROOT, 'apps/agor-daemon'),
    env: daemonEnv,
    stdio: ['ignore', daemonLog, daemonLog],
    detached: true,
    shell: true,
  });

  const uiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    VITE_DAEMON_PORT: String(DAEMON_PORT),
  };
  console.log(`[harness] starting UI on :${UI_PORT}...`);
  const uiLog = logFd(path.join(SCRATCH_DIR, 'ui.log'));
  const ui = spawn(`npx vite --port ${UI_PORT} --strictPort`, {
    cwd: path.join(REPO_ROOT, 'apps/agor-ui'),
    env: uiEnv,
    stdio: ['ignore', uiLog, uiLog],
    detached: true,
    shell: true,
  });

  const state: HarnessState = { daemonPid: daemon.pid!, uiPid: ui.pid! };

  if (agentMode) {
    if (agentMode === 'replay' && !existsSync(CASSETTE_PATH)) {
      throw new Error(
        `[harness] AGOR_E2E_AGENT_MODE=replay but no cassette at ${CASSETTE_PATH}. ` +
          'Record one first with AGOR_E2E_AGENT_MODE=live.'
      );
    }
    console.log(`[harness] starting cassette proxy on :${PROXY_PORT} (mode=${agentMode})...`);
    mkdirSync(CASSETTES_DIR, { recursive: true });
    const proxyLog = logFd(path.join(SCRATCH_DIR, 'cassette-proxy.log'));
    const proxy = spawn('npx tsx support/cassette-proxy-cli.ts', {
      cwd: path.join(REPO_ROOT, 'apps/agor-docs/demo-videos/e2e'),
      env: {
        ...process.env,
        AGOR_E2E_AGENT_MODE: agentMode,
        CASSETTE_PATH,
        PROXY_PORT: String(PROXY_PORT),
      },
      stdio: ['ignore', proxyLog, proxyLog],
      detached: true,
      shell: true,
    });
    state.proxyPid = proxy.pid!;
    await waitForHealth(`${PROXY_URL}/__cassette_health`, 15_000);
    console.log('[harness] cassette proxy healthy.');
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  await waitForHealth(`${DAEMON_URL}/health`, 30_000);
  await waitForHealth(BASE_URL, 30_000);
  const accessToken = await writeStorageState();
  await registerFrameworkRepo(accessToken);
  console.log('[harness] daemon + UI healthy; admin auth state minted.');
}

/**
 * A file descriptor the child writes to DIRECTLY (`stdio: ['ignore', fd, fd]`),
 * never a pipe through this process: a parent-owned pipe loses its reader the
 * moment the setup process exits (probe scripts exit immediately; only
 * Playwright's runner happens to stay alive), after which every console.log
 * in the daemon throws EPIPE — and the uncaught-exception report path logs
 * again, wedging the daemon in an infinite exception storm at 100% CPU.
 */
function logFd(logPath: string): number {
  return openSync(logPath, 'a');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Global teardown: kill the daemon + UI process groups, and the cassette
 * proxy if one is running. Scratch DB is left for post-mortem debugging.
 *
 * The proxy specifically needs an awaited, graceful SIGTERM (not the
 * process-group SIGTERM the daemon/UI get): its handler writes the recorded
 * cassette to disk before exiting in 'live' mode, and killing it before that
 * write completes would silently drop the recording.
 */
export async function teardownHarness(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as HarnessState;

  for (const pid of [state.daemonPid, state.uiPid]) {
    try {
      // Negative PID signals the whole detached process group (daemon spawns
      // its own children — tsx, executors); a plain kill(pid) would orphan them.
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already dead — fine.
    }
  }

  if (state.proxyPid) {
    try {
      process.kill(state.proxyPid, 'SIGTERM');
      await waitForExit(state.proxyPid, 10_000);
    } catch {
      // Already dead — fine.
    }
  }
}
