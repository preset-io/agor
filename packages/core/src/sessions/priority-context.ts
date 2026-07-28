/**
 * Priority context injection for brand-new root sessions.
 *
 * A repo can opt in to a `.agor/priority-context.json` manifest at its
 * worktree root, listing files that should be read and prepended as a
 * synthetic context message before a root session's first turn. This
 * replaces asking the agent to self-enforce a "read these files on a fresh
 * session" instruction (e.g. via a `BOOT.md` convention) — that convention
 * depends on the agent correctly recognizing session freshness and choosing
 * to act on it before answering, which can silently fail. Resolving and
 * injecting the manifest here, at session-bootstrap time, removes that
 * discretion: the content is either present before the first turn, or the
 * repo has no manifest.
 *
 * This is a one-time read at session creation, not a per-turn mechanism —
 * mirrors the read-once-at-start semantics of the `BOOT.md` convention it
 * replaces. It intentionally does not persist across context compaction the
 * way a harness's native `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` loading does;
 * content meant to hold for the whole conversation belongs in one of those
 * files instead, not this manifest.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface PriorityContextManifest {
  /** Paths relative to the worktree root. May contain a `{today}` segment. */
  files: string[];
  /**
   * Behavior when a listed file doesn't exist. Only `'skip'` is supported
   * today — session creation never fails because a designated file is
   * missing.
   */
  onMissing?: 'skip';
}

export interface PriorityContextFile {
  /** Path actually read, relative to the worktree root (post `{today}` resolution). */
  path: string;
  content: string;
}

const MANIFEST_RELATIVE_PATH = path.join('.agor', 'priority-context.json');
const TODAY_TOKEN = '{today}';

function isValidManifest(value: unknown): value is PriorityContextManifest {
  if (!value || typeof value !== 'object') return false;
  const files = (value as Record<string, unknown>).files;
  return Array.isArray(files) && files.every((entry) => typeof entry === 'string');
}

/**
 * Read and validate `.agor/priority-context.json` from a branch's worktree.
 * Returns `undefined` if the repo hasn't opted in, or the manifest is
 * missing/malformed — this feature is inert by default.
 */
export async function readPriorityContextManifest(
  worktreePath: string
): Promise<PriorityContextManifest | undefined> {
  const manifestPath = path.join(worktreePath, MANIFEST_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[priority-context] Failed to parse ${manifestPath}: ${(error as Error).message}`);
    return undefined;
  }

  if (!isValidManifest(parsed)) {
    console.warn(`[priority-context] Ignoring ${manifestPath}: expected { files: string[] }`);
    return undefined;
  }

  return parsed;
}

function formatDateToken(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Resolve `relativePath` against `worktreePath` and confirm the result
 * doesn't escape the worktree (`../`, an absolute path, a symlink pointing
 * outside, etc.). The manifest is repo-authored, but it's still read as
 * plain untrusted-ish data — a typo'd or malicious `../../.ssh/id_rsa`
 * entry must never turn into an arbitrary host-file read. Returns
 * `undefined` for anything outside the worktree, which callers treat the
 * same as a missing file (`onMissing: 'skip'`).
 */
async function resolveWithinWorktree(
  worktreePath: string,
  relativePath: string
): Promise<string | undefined> {
  if (path.isAbsolute(relativePath)) return undefined;

  const root = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const candidate = path.resolve(root, relativePath);
  const real = await fs.realpath(candidate).catch(() => candidate);

  const relativeToRoot = path.relative(root, real);
  const escapesRoot = relativeToRoot === '' ? false : relativeToRoot.startsWith('..');
  if (escapesRoot || path.isAbsolute(relativeToRoot)) return undefined;

  return candidate;
}

async function fileExistsWithinWorktree(
  worktreePath: string,
  relativePath: string
): Promise<boolean> {
  const safePath = await resolveWithinWorktree(worktreePath, relativePath);
  if (!safePath) return false;
  try {
    await fs.access(safePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a `{today}` segment in a manifest path to today's date, falling
 * back to yesterday's if today's file doesn't exist yet (mirrors the
 * existing `BOOT.md` convention: "if missing, read yesterday's daily log").
 * Paths without `{today}` pass through unchanged.
 */
async function resolveTemplatedPath(
  worktreePath: string,
  relativePath: string,
  now: Date
): Promise<string> {
  if (!relativePath.includes(TODAY_TOKEN)) return relativePath;

  const todayPath = relativePath.replace(TODAY_TOKEN, formatDateToken(now));
  if (await fileExistsWithinWorktree(worktreePath, todayPath)) return todayPath;

  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayPath = relativePath.replace(TODAY_TOKEN, formatDateToken(yesterday));
  if (await fileExistsWithinWorktree(worktreePath, yesterdayPath)) return yesterdayPath;

  // Neither exists — return today's path so the normal onMissing skip applies.
  return todayPath;
}

/**
 * Read a manifest's listed files from the worktree. Missing files, and any
 * path that resolves outside the worktree, are silently skipped —
 * `onMissing: 'skip'` is the only supported mode.
 */
export async function readPriorityContextFiles(
  worktreePath: string,
  manifest: PriorityContextManifest,
  now: Date = new Date()
): Promise<PriorityContextFile[]> {
  const results: PriorityContextFile[] = [];

  for (const rawPath of manifest.files) {
    const relativePath = await resolveTemplatedPath(worktreePath, rawPath, now);
    const safePath = await resolveWithinWorktree(worktreePath, relativePath);
    if (!safePath) {
      // resolveWithinWorktree only returns undefined for an absolute path or
      // one that escapes the worktree root — never for a merely-missing file.
      console.warn(`[priority-context] Skipping "${rawPath}": resolves outside the worktree`);
      continue;
    }
    try {
      const content = await fs.readFile(safePath, 'utf-8');
      results.push({ path: relativePath, content });
    } catch {
      // onMissing: 'skip' — the only supported mode today.
    }
  }

  return results;
}

const PRIORITY_CONTEXT_HEADER =
  "The following are this repo's designated priority-context files " +
  '(`.agor/priority-context.json`), provided automatically because this is ' +
  'a brand-new session. Treat them as established context, not as part of ' +
  "the message below — there's no need to re-read them yourself.";

/** Build the synthetic context message to prepend to a root session's first prompt. */
export function formatPriorityContextMessage(files: PriorityContextFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const sections = files.map((file) => `### ${file.path}\n\n${file.content.trim()}`).join('\n\n');
  return `${PRIORITY_CONTEXT_HEADER}\n\n${sections}`;
}

/**
 * End-to-end resolution: manifest + files + formatting. Returns `undefined`
 * when the repo has no manifest, or none of its listed files resolve to
 * content — callers should leave the prompt untouched in that case.
 */
export async function resolvePriorityContextForWorktree(
  worktreePath: string,
  now: Date = new Date()
): Promise<string | undefined> {
  const manifest = await readPriorityContextManifest(worktreePath);
  if (!manifest) return undefined;

  const files = await readPriorityContextFiles(worktreePath, manifest, now);
  return formatPriorityContextMessage(files);
}
