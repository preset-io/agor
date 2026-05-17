#!/usr/bin/env node
/**
 * Regression guard: forbid ad-hoc UUID truncation.
 *
 * Every short form of a UUID must go through `shortId(id)` (or `toShortId`
 * for the rare documented non-canonical-length case). This script greps
 * apps/ and packages/ for the patterns that originally caused the
 * same-millisecond collision bug:
 *
 *   1. `<chain>.<id-leaf>.(substring|slice)(0, N)` — receiver name says
 *      UUID. Leaf names that count: anything ending in `_id`/`Id`, the
 *      bare `id` (covers `latest.id`, route-param `id`), and a curated
 *      list of known aliases (`sessionId`, `taskId`, etc.) that don't
 *      follow the suffix rule.
 *
 *   2. `<anything>.replace(/-/g, '').slice(0, N)` — the explicit "strip
 *      hyphens, take first N hex chars" pattern. Always a UUID display
 *      in this codebase.
 *
 *   3. `String(<id-expr>).(substring|slice)(0, N)` — the wrapper-cast
 *      variant that escapes pattern 1 by breaking the property chain.
 *
 * Exits non-zero on any violation. Wire into CI / pre-commit via
 * `pnpm check:shortid`.
 *
 * Per-line escape hatch: `// shortid-guard:ignore <reason>` or the JSX
 * block-comment form `{/* shortid-guard:ignore <reason> *\/}` on the
 * offending line itself or the line directly above. Pragma must explain
 * why the receiver isn't a UUIDv7.
 *
 * Allowlist (whole-file): the helper itself, the type definitions, the
 * Unix-naming carve-out, the integration test scripts.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TARGETS = ['apps', 'packages'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache']);

const ALLOWLIST = new Set([
  'packages/core/src/lib/ids.ts',
  'packages/core/src/lib/ids.test.ts',
  'packages/core/src/types/id.ts',
  'packages/core/src/unix/group-manager.ts',
  'packages/core/src/unix/user-manager.ts',
  'packages/core/src/db/scripts/test-integration.ts',
  'packages/core/src/db/scripts/test-integration.test.ts',
]);

// `reportId` and `displayId` are intentionally OMITTED — reports are
// addressed by file path (`<session-id>/<task-id>.md`), not UUIDv7, and
// `displayId` is a generic alias that may not be a UUID.
const KNOWN_NAMES = [
  'sessionId',
  'taskId',
  'userId',
  'boardId',
  'worktreeId',
  'repoId',
  'messageId',
  'commentId',
  'artifactId',
  'mcpServerId',
  'targetSessionId',
  'childSessionId',
  'parentSessionId',
  'callbackSessionId',
  'sdkSessionId',
  'opencodeSessionId',
  'callerSessionId',
  'btwSessionId',
  'forkedFromId',
  'fromSessionId',
  'forkedThreadId',
  'threadId',
  'agentSessionId',
  'fullId',
  'latestTaskId',
  'creatorId',
  'prompterUserId',
  'payloadUserId',
  'targetRepoId',
  'installationIdNum',
  'targetId',
  'parentId',
].join('|');

// All built via `new RegExp(String.raw)` so we don't have to fight Biome's
// regex-literal parser over the nested forward slashes in pattern 2.
const PATTERNS = [
  // 1a. Chained access ending in `_id`, `Id`, or a known alias.
  new RegExp(
    String.raw`\b\w*(?:_id|Id|${KNOWN_NAMES})!?\??\.(?:substring|slice)\(\s*0\s*,\s*\d+\s*\)`
  ),
  // 1b. Bare `id` as receiver (route params, destructured rows, `latest.id`).
  //     Non-word boundary before `id` avoids matching words like "valid".
  new RegExp(String.raw`(?:^|[^\w])id!?\??\.(?:substring|slice)\(\s*0\s*,\s*\d+\s*\)`),
  // 2. `.replace(/-/g, '').slice(0, N)` — canonical strip-hyphens chain.
  // biome-ignore lint/performance/useTopLevelRegex: built dynamically alongside the others
  new RegExp(String.raw`\.replace\(\/-\/g,\s*['"]{2}\)\.slice\(\s*0\s*,\s*\d+\s*\)`),
  // 3. `String(<id-expr>).(substring|slice)(0, N)` — wrapper-cast variant.
  new RegExp(
    String.raw`\bString\([^)]*(?:_id|Id|${KNOWN_NAMES})[^)]*\)\.(?:substring|slice)\(\s*0\s*,\s*\d+\s*\)`
  ),
];

const PRAGMA_RE = /shortid-guard:ignore\b/;

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
      `\n❌ ${violations} ad-hoc UUID truncation${violations === 1 ? '' : 's'} found.\n` +
        `\nUse \`shortId(id)\` from \`@agor/core/db\` (or \`@agor-live/client\`\n` +
        `in browser code) instead of \`.substring(0, N)\` / \`.slice(0, N)\` on a\n` +
        `UUID. The helper emits the canonical SHORT_ID_LENGTH-char form that's\n` +
        `collision-safe for same-millisecond IDs (the "Child session 019e372a\n` +
        `has completed" bug this guard exists to prevent).\n` +
        `\nIf you genuinely need a non-canonical length for a documented reason,\n` +
        `use \`toShortId(id, length)\` and add your file to the allowlist in\n` +
        `\`scripts/check-no-ad-hoc-shortid.mjs\`.\n` +
        `\nFor a non-UUID receiver whose name happens to match the regex\n` +
        `(e.g. \`reportId\` is a file path), add \`// shortid-guard:ignore\n` +
        `<reason>\` on the line above (or on the same line).`
    );
    process.exit(1);
  }

  console.log('✅ No ad-hoc UUID truncation found.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
