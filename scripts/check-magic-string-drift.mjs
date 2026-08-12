#!/usr/bin/env node
/**
 * Regression guard: forbid re-listing the streaming/thinking event names.
 *
 * The daemon broadcasts a fixed set of per-chunk streaming events on the
 * `messages` service — `streaming:start|chunk|end|error` and
 * `thinking:start|chunk|end`. Their single source of truth is the
 * `STREAMING_EVENT_TYPES` array (and the derived `StreamingEventType` /
 * `MESSAGE_STREAM_LIFECYCLE_EVENTS`) in `packages/core/src/types/message.ts`.
 * These names used to be re-typed by hand in `register-services.ts` (a service
 * `events:` array), `gateway.ts` (a union type), and `register-routes.ts` (an
 * equality chain); a typo or an added event in one place silently diverged
 * from the others. See `context/guidelines/constants.md`.
 *
 * This script greps `apps/agor-daemon/src` — the surface that was
 * deduplicated — for the two shapes that RE-LIST the set as raw literals:
 *
 *   A. Two or more quoted event literals on one line — a union type
 *      (`'streaming:start' | 'streaming:chunk' | ...`), a single-line array
 *      or `Set`, or an equality chain (`e === 'streaming:start' || e === ...`).
 *
 *   B. A line that is just one quoted event literal (optional trailing comma)
 *      — the element of a hand-written multi-line array.
 *
 * It deliberately does NOT flag an idiomatic single-literal comparison
 * (`if (event === 'streaming:chunk')`) against an already-typed union, and it
 * is NOT a general-purpose magic-string linter — that is future work (see
 * `context/guidelines/constants.md`). It guards exactly the case just fixed.
 *
 * Exits non-zero on any violation. Wire into CI via `pnpm check:magic-string-drift`.
 *
 * Per-line escape hatch: `// magic-string-guard:ignore <reason>` on the
 * offending line itself or the line directly above. The pragma must explain
 * why the literal is legitimately not sourced from the shared constant.
 *
 * Allowlist (whole-file): the shared-constant declaration itself lives in
 * `packages/core` (outside the scanned tree). `tasks-events.ts` is the
 * canonical task-events list and legitimately names `thinking:chunk` as one
 * of the custom `tasks` events, so it is exempt.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TARGETS = ['apps/agor-daemon/src'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache']);

const ALLOWLIST = new Set([
  // Canonical custom-events list for the `tasks` service. `thinking:chunk` is
  // genuinely one of these events; it is declared here as its own source of
  // truth, not re-listed from the message-streaming set.
  'apps/agor-daemon/src/services/tasks-events.ts',
]);

// A single quoted streaming/thinking event literal.
const QUOTED_EVENT = `['"](?:streaming:(?:start|chunk|end|error)|thinking:(?:start|chunk|end))['"]`;

const PATTERNS = [
  // A. Two or more quoted event literals on one line (union / array / Set /
  //    equality chain that re-lists the set).
  new RegExp(`${QUOTED_EVENT}[^\\n]*${QUOTED_EVENT}`),
  // B. A standalone quoted event literal — a hand-written array element.
  new RegExp(String.raw`^\s*${QUOTED_EVENT},?\s*$`),
];

const PRAGMA_RE = /magic-string-guard:ignore\b/;

function lineMatches(line) {
  return PATTERNS.some((re) => re.test(line));
}

async function* walk(dir) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of ents) {
    if (IGNORE_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile() && /\.(ts|tsx)$/.test(ent.name)) {
      yield full;
    }
  }
}

async function dirExists(abs) {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let violations = 0;
  for (const dir of TARGETS) {
    const abs = path.join(ROOT, dir);
    if (!(await dirExists(abs))) continue;
    for await (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lineMatches(lines[i])) continue;
        const prev = lines[i - 1] ?? '';
        if (PRAGMA_RE.test(prev) || PRAGMA_RE.test(lines[i])) continue;
        console.error(`${rel}:${i + 1}: ${lines[i].trim()}`);
        violations++;
      }
    }
  }

  if (violations > 0) {
    console.error(
      `\n❌ ${violations} re-listed streaming event name${violations === 1 ? '' : 's'} found.\n` +
        `\nThe streaming/thinking event names have a single source of truth:\n` +
        `\`STREAMING_EVENT_TYPES\` (and the derived \`StreamingEventType\` /\n` +
        `\`MESSAGE_STREAM_LIFECYCLE_EVENTS\`) in\n` +
        `\`packages/core/src/types/message.ts\`. Import and spread/derive from it\n` +
        `instead of retyping the literals as a union, array, Set, or equality\n` +
        `chain at the call site. See \`context/guidelines/constants.md\`.\n` +
        `\nAn idiomatic single-literal comparison against an already-typed union\n` +
        `(\`if (event === 'streaming:chunk')\`) is fine and is not flagged. If a\n` +
        `line legitimately needs to name these events, add\n` +
        `\`// magic-string-guard:ignore <reason>\` on the line above (or same line).`
    );
    process.exit(1);
  }

  console.log('✅ No re-listed streaming event names found.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
