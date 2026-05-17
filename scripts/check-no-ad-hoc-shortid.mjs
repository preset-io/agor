#!/usr/bin/env node
/**
 * Regression guard: forbid ad-hoc UUID truncation.
 *
 * Every short form of a UUID must go through `shortId(id)` (or `toShortId`
 * for the rare documented non-canonical-length case). This script greps
 * apps/ and packages/ for the legacy patterns that motivated this guard:
 *
 *   <something>Id.substring(0, N)
 *   <something>Id.slice(0, N)
 *   <something>_id.substring(0, N)
 *   <something>_id.slice(0, N)
 *
 * The receiver name is what tells us this is a UUID, not a content/hash/SHA
 * truncation — we'd rather narrow on the receiver shape than try to read
 * minds about lengths. Patterns are restricted to:
 *   - last segment matches /^(.*[Ii]d|.*_id)$/
 *   - length N is anything (not just 8) — once a UUID identifier is being
 *     sliced, the right answer is always `shortId(receiver)`.
 *
 * Exits non-zero on any violation. Wire into CI / pre-commit.
 *
 * Allowlist: the helper itself, the Unix-naming carve-out, and the integration
 * test scripts that exist specifically to characterize the primitive.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TARGETS = ['apps', 'packages'];
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache']);

// Files allowed to use the lower-level primitives directly.
const ALLOWLIST = new Set([
  'packages/core/src/lib/ids.ts',
  'packages/core/src/lib/ids.test.ts',
  'packages/core/src/types/id.ts',
  'packages/core/src/unix/group-manager.ts',
  'packages/core/src/unix/user-manager.ts',
  'packages/core/src/db/scripts/test-integration.ts',
  'packages/core/src/db/scripts/test-integration.test.ts',
]);

// Match `<chain>.substring(0, N)` or `<chain>.slice(0, N)` where the last
// chain segment looks like a UUID identifier (`*_id`, `*Id`, or known names).
// Tolerates `!` non-null assertion, `?.` optional chain.
//
// Note: `reportId` is intentionally OMITTED — reports are addressed by file
// path (`<session-id>/<task-id>.md`), not UUIDv7. `displayId` is also
// omitted since it's a generic display alias that may not be a UUID.
const KNOWN_NAMES =
  'sessionId|taskId|userId|boardId|worktreeId|repoId|messageId|commentId|' +
  'artifactId|mcpServerId|targetSessionId|childSessionId|parentSessionId|' +
  'callbackSessionId|sdkSessionId|opencodeSessionId|callerSessionId|' +
  'btwSessionId|forkedFromId|fromSessionId|forkedThreadId|threadId|' +
  'agentSessionId|fullId|latestTaskId|creatorId|prompterUserId|' +
  'payloadUserId|targetRepoId|installationIdNum|targetId|parentId';

const PATTERN = new RegExp(
  String.raw`\b\w*(?:_id|Id|${KNOWN_NAMES})!?\??\.(?:substring|slice)\(\s*0\s*,\s*\d+\s*\)`
);

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

let violations = 0;
for (const dir of TARGETS) {
  const abs = path.join(ROOT, dir);
  let exists = true;
  try {
    await fs.stat(abs);
  } catch {
    exists = false;
  }
  if (!exists) continue;
  for await (const file of walk(abs)) {
    const rel = path.relative(ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!PATTERN.test(lines[i])) continue;
      // Per-line escape hatch for the rare receiver whose name happens to
      // match the UUID regex but isn't actually a UUIDv7 (e.g. `reportId`
      // is a `<session>/<task>.md` file path). Pragma must explain why.
      // Accepts `// shortid-guard:ignore <reason>` or the JSX block-comment
      // form `{/* shortid-guard:ignore <reason> */}` on the line itself or
      // the line directly above.
      const pragmaRe = /shortid-guard:ignore\b/;
      const prev = lines[i - 1] ?? '';
      if (pragmaRe.test(prev) || pragmaRe.test(lines[i])) continue;
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
      `\`scripts/check-no-ad-hoc-shortid.mjs\`.`
  );
  process.exit(1);
}

console.log('✅ No ad-hoc UUID truncation found.');
