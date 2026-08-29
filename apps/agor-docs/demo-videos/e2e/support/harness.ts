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
export const SECRETS_FILE = path.join(SCRATCH_DIR, 'secrets.env');

export const DAEMON_PORT = 3131;
export const UI_PORT = 5199;
export const BASE_URL = `http://localhost:${UI_PORT}`;
export const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;
export const DATABASE_URL = `file:${DB_PATH}`;

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

/** Global setup: reset scratch env, migrate + seed, spawn daemon + UI. */
export async function setupHarness(): Promise<void> {
  const keepScratch = process.env.AGOR_E2E_KEEP_SCRATCH === '1';
  const secrets = loadSecrets();

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

/** Global teardown: kill the daemon + UI process groups. Scratch DB is left for post-mortem debugging. */
export function teardownHarness(): void {
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
}
