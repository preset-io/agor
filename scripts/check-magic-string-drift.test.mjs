import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkMagicStringDrift } from './check-magic-string-drift.mjs';

const DEFAULT_EVENTS = [
  'streaming:start',
  'streaming:chunk',
  'streaming:end',
  'streaming:error',
  'thinking:start',
  'thinking:chunk',
  'thinking:end',
];

async function run(candidate, events = DEFAULT_EVENTS) {
  const root = mkdtempSync(join(tmpdir(), 'agor-magic-string-'));
  try {
    const canonical = join(root, 'packages/core/src/types/message.ts');
    const target = join(root, 'apps/agor-daemon/src/candidate.ts');
    mkdirSync(dirname(canonical), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      canonical,
      `const BASE_EVENTS = ${JSON.stringify(events.slice(0, 4))} as const;\n` +
        `export const STREAMING_EVENT_TYPES = [...BASE_EVENTS, ${events
          .slice(4)
          .map((value) => JSON.stringify(value))
          .join(', ')}] as const;\n`
    );
    writeFileSync(target, candidate);
    return await checkMagicStringDrift({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('detects multiline unions, arrays/Sets with comments, and equality chains', async () => {
  const violations = await run(`
type Repeated =
  | 'streaming:start'
  | 'streaming:chunk';
const array = [
  'streaming:start', // begin
  'streaming:end', // finish
];
const set = new Set([
  'thinking:start',
  'thinking:end',
]);
const matches =
  event === 'streaming:start' ||
  event === 'streaming:chunk' ||
  event === 'streaming:end';
`);
  assert.equal(violations.length, 4);
  assert.match(violations.join('\n'), /union/);
  assert.match(violations.join('\n'), /array/);
  assert.match(violations.join('\n'), /equality chain/);
});

test('allows individual comparisons, singleton arrays, and comments', async () => {
  assert.deepEqual(
    await run(`
const one = event === 'streaming:chunk';
const singleton = ['streaming:start'];
// The lifecycle moves from 'streaming:start' to 'streaming:end'.
`),
    []
  );
});

test('derives newly added canonical members instead of duplicating the family in the guard', async () => {
  const violations = await run(`const repeated = ['streaming:start', 'streaming:resume'];`, [
    ...DEFAULT_EVENTS,
    'streaming:resume',
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /streaming:resume/);
});

test('requires an explanation on the escape hatch', async () => {
  const missingReason = await run(`
// magic-string-guard:ignore
const repeated = ['streaming:start', 'streaming:end'];
`);
  assert.equal(missingReason.length, 1);
  assert.match(missingReason[0], /requires a reason/);

  assert.deepEqual(
    await run(`
// magic-string-guard:ignore separate protocol owner
const repeated = ['streaming:start', 'streaming:end'];
`),
    []
  );
});
