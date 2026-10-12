// Build a seed (support/seeds.ts) into a cached checkpoint.
//
//   npm run seed -- <name>             # reuse the cached checkpoint, or build what's missing
//   npm run seed -- <name> --rebuild   # rebuild <name> itself (ancestors stay cached)
//   npm run seed -- <name> --live      # agent seeds: record their turns again
//   npm run seed -- --list
//
// Checkpoints are named seed-<name>-<hash> in ~/.agor-e2e/checkpoints. The
// hash covers the seed's code, its ancestors' hashes, and the seeding
// library, so a stale state is never reused by accident.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASSETTES_DIR,
  CHECKPOINTS_DIR,
  setupHarness,
  snapshotCheckpoint,
  teardownHarness,
} from '../support/harness.ts';
import { Seeder } from '../support/seeder.ts';
import { SEEDS, type SeedDef, seedByName, seedChain } from '../support/seeds.ts';
import { readWorld, writeWorld } from '../support/world.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(HERE, '..');
const LIB_FILES = ['support/seeder.ts', 'support/cast.ts', 'support/api.ts', 'support/world.ts'];

function libHash(): string {
  const h = createHash('sha256');
  for (const f of LIB_FILES) h.update(readFileSync(path.join(E2E_DIR, f)));
  return h.digest('hex');
}

/** Checkpoint name for every seed in the chain, root first. */
export function seedCheckpoints(name: string): { seed: SeedDef; checkpoint: string }[] {
  const lib = libHash();
  let parent = '';
  return seedChain(name).map((seed) => {
    parent = createHash('sha256')
      .update(parent)
      .update(lib)
      .update(seed.name)
      .update(String(seed.agent === true))
      .update(seed.run.toString())
      .digest('hex');
    return { seed, checkpoint: `seed-${seed.name}-${parent.slice(0, 10)}` };
  });
}

function hasCheckpoint(name: string): boolean {
  return existsSync(path.join(CHECKPOINTS_DIR, name, 'agor-e2e.db'));
}

/** Make sure the seed's checkpoint exists (building what's missing). Returns its name. */
export function ensureSeed(
  name: string,
  options: { rebuild?: boolean; live?: boolean } = {}
): string {
  const plan = seedCheckpoints(name);
  const target = plan[plan.length - 1];
  if (options.rebuild)
    rmSync(path.join(CHECKPOINTS_DIR, target.checkpoint), { recursive: true, force: true });
  if (hasCheckpoint(target.checkpoint)) {
    console.log(`[seed] ${name}: cached (${target.checkpoint})`);
    return target.checkpoint;
  }
  let start = -1;
  for (let i = plan.length - 1; i >= 0; i--) {
    if (hasCheckpoint(plan[i].checkpoint)) {
      start = i;
      break;
    }
  }
  const todo = plan.slice(start + 1);
  console.log(
    `[seed] ${name}: building ${todo.map((t) => t.seed.name).join(' -> ')}` +
      (start >= 0 ? ` on top of ${plan[start].checkpoint}` : ' from an empty workspace')
  );
  const env: NodeJS.ProcessEnv = { ...process.env, AGOR_E2E_CHECKPOINTS: '0' };
  delete env.AGOR_E2E_FROM_CHECKPOINT;
  delete env.AGOR_E2E_KEEP_SCRATCH;
  if (start >= 0) env.AGOR_E2E_FROM_CHECKPOINT = plan[start].checkpoint;
  if (todo.some((t) => t.seed.agent)) {
    const cassette = `seed-${name}`;
    env.AGOR_E2E_CASSETTE_NAME = cassette;
    env.AGOR_E2E_AGENT_MODE =
      options.live || !existsSync(path.join(CASSETTES_DIR, `${cassette}.json`)) ? 'live' : 'replay';
  } else {
    delete env.AGOR_E2E_AGENT_MODE;
  }
  const res = spawnSync(
    'npx',
    ['tsx', 'scripts/seed.ts', '--run', name, ...todo.map((t) => `${t.seed.name}=${t.checkpoint}`)],
    { cwd: E2E_DIR, env, stdio: 'inherit' }
  );
  if (res.status !== 0 || !hasCheckpoint(target.checkpoint)) {
    throw new Error(`[seed] building ${name} failed`);
  }
  return target.checkpoint;
}

/** Child process: boot the harness, run the missing seeds, snapshot each. */
async function runSeeds(steps: { name: string; checkpoint: string }[]): Promise<void> {
  await setupHarness();
  try {
    for (const step of steps) {
      console.log(`[seed] running ${step.name}...`);
      const world = readWorld();
      await seedByName(step.name).run(new Seeder(world));
      writeWorld(world);
      // Drop stale builds of this seed before keeping the new one.
      for (const dir of readdirSync(CHECKPOINTS_DIR)) {
        if (dir.startsWith(`seed-${step.name}-`) && dir !== step.checkpoint) {
          rmSync(path.join(CHECKPOINTS_DIR, dir), { recursive: true, force: true });
        }
      }
      snapshotCheckpoint(step.checkpoint);
      console.log(`[seed] ${step.name} -> ${step.checkpoint}`);
    }
  } finally {
    await teardownHarness();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--run') {
    const steps = args.slice(2).map((a) => {
      const [name, checkpoint] = a.split('=');
      return { name, checkpoint };
    });
    await runSeeds(steps);
    return;
  }
  if (args.includes('--list') || args.length === 0) {
    for (const s of SEEDS) {
      const cp = seedCheckpoints(s.name).at(-1)!.checkpoint;
      console.log(
        `${s.name}${s.extends ? ` (extends ${s.extends})` : ''}${hasCheckpoint(cp) ? ' [cached]' : ''}\n  ${s.description}`
      );
    }
    return;
  }
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) throw new Error('Usage: npm run seed -- <name> [--rebuild] [--live]');
  ensureSeed(name, { rebuild: args.includes('--rebuild'), live: args.includes('--live') });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
}
