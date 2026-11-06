/**
 * Entry-name rules for `.agor` files. Every name is validated before any
 * byte of the entry is read: relative, normalized, no traversal or control
 * characters, and matching one of the known layout patterns. The same rules
 * gate what the executor collects from a branch and what it writes back.
 */

import { AGOR_PACK } from '../types/agor-pack';

export class AgorPackFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgorPackFormatError';
  }
}

const KEY = 't[0-9]{2,3}';
const SEQ = '[0-9]{4}';
const UPLOAD_REF = 'upl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PREFIX = `^teammates/${KEY}/`;

const LAYOUT: readonly RegExp[] = [
  new RegExp(
    `${PREFIX}(teammate\\.json|board\\.json|schedules\\.json|knowledge/manifest\\.yaml|knowledge/history\\.json|git/state\\.json|git/repo\\.bundle)$`
  ),
  new RegExp(`${PREFIX}artifacts/${SEQ}\\.json$`),
  new RegExp(`${PREFIX}sessions/${SEQ}(\\.json|\\.messages\\.jsonl)$`),
  new RegExp(`${PREFIX}uploads/${UPLOAD_REF}\\.(json|data)$`),
  new RegExp(`${PREFIX}knowledge/docs/.+\\.md$`),
  new RegExp(`${PREFIX}git/worktree/.+$`),
  new RegExp(`${PREFIX}sdk-home/claude/.+$`),
];

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_BYTES = 255;

/** Reject anything that is not a plain, normalized, relative POSIX path. */
export function assertSafeRelativePackPath(path: string): void {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new AgorPackFormatError('Pack entry name is empty or too long');
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new AgorPackFormatError(`Pack entry name is not a relative POSIX path: ${path}`);
  }
  if (path.normalize('NFC') !== path) {
    throw new AgorPackFormatError(`Pack entry name is not NFC-normalized: ${path}`);
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new AgorPackFormatError(`Pack entry name has an unsafe segment: ${path}`);
    }
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) {
      throw new AgorPackFormatError(`Pack entry name has an overlong segment: ${path}`);
    }
  }
}

/** Teammate key of a layout path (`teammates/<key>/…`), or null. */
export function teammateKeyOfPath(path: string): string | null {
  return new RegExp(`^teammates/(${KEY})/`).exec(path)?.[1] ?? null;
}

/**
 * Validate one entry name against the pack layout. The manifest itself is the
 * only name outside `teammates/`.
 */
export function assertAgorPackEntryPath(path: string): void {
  assertSafeRelativePackPath(path);
  if (path === AGOR_PACK.manifestPath) return;
  if (!LAYOUT.some((pattern) => pattern.test(path))) {
    throw new AgorPackFormatError(`Pack entry is not part of the .agor layout: ${path}`);
  }
  const worktree = new RegExp(`${PREFIX}git/worktree/(.+)$`).exec(path);
  if (worktree && !isPortableWorktreePath(worktree[1] as string)) {
    throw new AgorPackFormatError(`Pack entry is not an allowed working-tree file: ${path}`);
  }
  const claude = new RegExp(`${PREFIX}sdk-home/claude/(.+)$`).exec(path);
  if (claude && !isAllowedClaudeHomePath(claude[1] as string)) {
    throw new AgorPackFormatError(`Pack entry is not an allowed Claude home file: ${path}`);
  }
}

/**
 * Branch-home allow-list, relative to `branch-homes/<id>/claude/`: auto-memory,
 * user-authored skills/agents/commands, and CLAUDE.md. Credentials, settings
 * (hooks), transcripts, todos, and caches never qualify.
 */
export function isAllowedClaudeHomePath(relative: string): boolean {
  try {
    assertSafeRelativePackPath(relative);
  } catch {
    return false;
  }
  if (relative === 'CLAUDE.md') return true;
  const segments = relative.split('/');
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  if (segments.length >= 4 && segments[0] === 'projects' && segments[2] === 'memory') {
    return !relative.endsWith('.jsonl');
  }
  return (
    segments.length >= 2 &&
    (segments[0] === 'skills' || segments[0] === 'agents' || segments[0] === 'commands')
  );
}

const DENIED_WORKTREE_BASENAMES =
  /^(\.env(\..*)?|.*\.pem|.*\.key|id_[^/]*|\.npmrc|\.netrc|\.pypirc|\.git-credentials)$/i;

/**
 * Working-tree files that may travel: never anything inside a `.git`
 * directory, and never common secret-bearing files even when untracked and not
 * ignored.
 */
export function isPortableWorktreePath(relative: string): boolean {
  try {
    assertSafeRelativePackPath(relative);
  } catch {
    return false;
  }
  const segments = relative.split('/');
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return false;
  return !DENIED_WORKTREE_BASENAMES.test(segments[segments.length - 1] as string);
}

/**
 * Claude Code's project directory name for a working directory: every
 * character outside `[A-Za-z0-9]` becomes `-`.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Rename a `projects/<slug>/…` path from the source branch's slug to the
 * destination's. Subdirectory slugs (`<slug>-sub-dir`) follow the same prefix.
 */
export function renameClaudeProjectPath(
  relative: string,
  fromSlug: string | null,
  toSlug: string
): string {
  const match = /^projects\/([^/]+)\/(.*)$/.exec(relative);
  if (!match || !fromSlug) return relative;
  const slug = match[1] as string;
  if (slug !== fromSlug && !slug.startsWith(`${fromSlug}-`)) return relative;
  return `projects/${toSlug}${slug.slice(fromSlug.length)}/${match[2]}`;
}

export function teammatePackPath(key: string, relative: string): string {
  return `teammates/${key}/${relative}`;
}

export function packSequence(index: number): string {
  return String(index + 1).padStart(4, '0');
}
