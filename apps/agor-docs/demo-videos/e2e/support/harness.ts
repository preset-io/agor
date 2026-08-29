// Spins up a fully isolated, real Agor daemon + UI for the E2E suite:
// a scratch SQLite DB (migrated + seeded via the project's own
// `pnpm load:fixtures`), a scratch git data home, and dedicated ports —
// entirely separate from the developer's real ~/.agor/agor.db and real
// daemon. Never touches the real deployment.
//
// "Reset to stock" per run: the scratch dir is wiped and rebuilt from
// scratch every time global-setup runs, so the suite always starts from a
// known state (set AGOR_E2E_KEEP_SCRATCH=1 to skip the wipe for faster local
// iteration on a single spec file).

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = apps/agor-docs/demo-videos/e2e/support -> repo root is 5 levels up.
export const REPO_ROOT = path.resolve(HERE, '../../../../..');
export const SCRATCH_DIR = path.join(REPO_ROOT, '.e2e-runtime');
export const DB_PATH = path.join(SCRATCH_DIR, 'agor-e2e.db');
export const DATA_HOME = path.join(SCRATCH_DIR, 'data');
export const STATE_FILE = path.join(SCRATCH_DIR, 'harness-state.json');
// Deliberately OUTSIDE SCRATCH_DIR: user-provided, persists across the
// "reset to stock" wipe below (which recursively removes SCRATCH_DIR).
export const SECRETS_DIR = path.join(REPO_ROOT, '.e2e-secrets');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.env');

export const DAEMON_PORT = 3131;
export const UI_PORT = 5199;
export const PROXY_PORT = 8899;
export const BASE_URL = `http://localhost:${UI_PORT}`;
export const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;
export const PROXY_URL = `http://localhost:${PROXY_PORT}`;
export const DATABASE_URL = `file:${DB_PATH}`;

// Committed (not gitignored): recorded cassettes are what makes replay mode
// work without live credentials or network — see cassette-proxy.ts.
export const CASSETTES_DIR = path.join(HERE, '../cassettes');
// One cassette for now (single live-agent spec); name it if/when a second
// live-agent-invoking spec is added.
export const CASSETTE_NAME = process.env.AGOR_E2E_CASSETTE_NAME ?? 'live-agent-session';
export const CASSETTE_PATH = path.join(CASSETTES_DIR, `${CASSETTE_NAME}.json`);

/** 'live' | 'replay' | null (no real agent call in this run — most specs). */
export type AgentMode = 'live' | 'replay' | null;
export function resolveAgentMode(): AgentMode {
  const raw = process.env.AGOR_E2E_AGENT_MODE;
  return raw === 'live' || raw === 'replay' ? raw : null;
}

/** Demo users seeded by `loadDemoFixtures` — packages/core/src/seed/demo-fixtures.ts. */
export const DEMO_USERS = {
  alice: { email: 'demo.alice@agor.live', password: 'demo-password-alice', role: 'admin' },
  bob: { email: 'demo.bob@agor.live', password: 'demo-password-bob', role: 'member' },
  carol: { email: 'demo.carol@agor.live', password: 'demo-password-carol', role: 'member' },
  dave: { email: 'demo.dave@agor.live', password: 'demo-password-dave', role: 'viewer' },
} as const;

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

// `loadDemoFixtures` is deliberately pure-DB (its own docstring: "no git
// clones, no network, no executor") and writes fixed placeholder paths —
// see packages/core/src/seed/demo-fixtures.ts. Fine for every UI/DB-only
// spec, which never touches disk. A REAL agent turn needs a REAL working
// directory to operate in, though, so when a live/replay agent test is
// requested we back exactly that fixed path with a real, tiny git repo —
// entirely outside demo-fixtures.ts (which must stay fast and network-free
// for its many other callers) and outside this repo's own tree.
const DEMO_FIXTURE_WORKTREE = '/tmp/demo-fixtures/worktrees/demo-fix-navbar';
function ensureDemoFixtureWorktree(): void {
  if (existsSync(path.join(DEMO_FIXTURE_WORKTREE, '.git'))) return;
  console.log(`[harness] backing the seeded demo-fix-navbar branch with a real git repo...`);
  mkdirSync(DEMO_FIXTURE_WORKTREE, { recursive: true });
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: DEMO_FIXTURE_WORKTREE, stdio: 'ignore' });
  git(['init']);
  git(['config', 'user.email', 'e2e@agor.live']);
  git(['config', 'user.name', 'Agor E2E']);
  writeFileSync(path.join(DEMO_FIXTURE_WORKTREE, 'README.md'), '# demo-webapp\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial commit']);
}

/** Global setup: reset scratch env, migrate + seed, spawn daemon + UI. */
export async function setupHarness(): Promise<void> {
  const keepScratch = process.env.AGOR_E2E_KEEP_SCRATCH === '1';
  const secrets = loadSecrets();
  const agentMode = resolveAgentMode();

  if (!keepScratch || !existsSync(DB_PATH)) {
    rmSync(SCRATCH_DIR, { recursive: true, force: true });
    mkdirSync(DATA_HOME, { recursive: true });

    const dbEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL };
    console.log('[harness] migrating scratch database...');
    run('pnpm', ['agor', 'db', 'migrate', '-y'], REPO_ROOT, dbEnv);

    console.log('[harness] seeding demo fixtures...');
    run('pnpm', ['load:fixtures'], REPO_ROOT, dbEnv);
  } else {
    console.log('[harness] AGOR_E2E_KEEP_SCRATCH=1 and scratch DB exists — skipping reset.');
  }

  if (agentMode) ensureDemoFixtureWorktree();

  // Real agentic-tool keys (ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN)
  // read from the gitignored secrets file, never from the shell directly —
  // see .e2e-runtime/secrets.env (untracked, mode 0600).
  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...secrets,
    DATABASE_URL,
    AGOR_DATA_HOME: DATA_HOME,
    PORT: String(DAEMON_PORT),
    NODE_ENV: 'development',
    CORS_ORIGIN: BASE_URL,
  };
  console.log(`[harness] starting daemon on :${DAEMON_PORT}...`);
  const daemon = spawn('npx tsx src/main.ts', {
    cwd: path.join(REPO_ROOT, 'apps/agor-daemon'),
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: true,
  });
  pipeToLog(daemon, path.join(SCRATCH_DIR, 'daemon.log'));

  const uiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    VITE_DAEMON_PORT: String(DAEMON_PORT),
  };
  console.log(`[harness] starting UI on :${UI_PORT}...`);
  const ui = spawn(`npx vite --port ${UI_PORT} --strictPort`, {
    cwd: path.join(REPO_ROOT, 'apps/agor-ui'),
    env: uiEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: true,
  });
  pipeToLog(ui, path.join(SCRATCH_DIR, 'ui.log'));

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
    const proxy = spawn('npx tsx support/cassette-proxy-cli.ts', {
      cwd: path.join(REPO_ROOT, 'apps/agor-docs/demo-videos/e2e'),
      env: {
        ...process.env,
        AGOR_E2E_AGENT_MODE: agentMode,
        CASSETTE_PATH,
        PROXY_PORT: String(PROXY_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      shell: true,
    });
    pipeToLog(proxy, path.join(SCRATCH_DIR, 'cassette-proxy.log'));
    state.proxyPid = proxy.pid!;
    await waitForHealth(`${PROXY_URL}/__cassette_health`, 15_000);
    console.log('[harness] cassette proxy healthy.');
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  await waitForHealth(`${DAEMON_URL}/health`, 30_000);
  await waitForHealth(BASE_URL, 30_000);
  console.log('[harness] daemon + UI healthy.');
}

function pipeToLog(child: ChildProcess, logPath: string): void {
  const stream = createWriteStream(logPath, { flags: 'a' });
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
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
