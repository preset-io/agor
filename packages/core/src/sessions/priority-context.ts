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

import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EffectiveBranchAccess } from '../types/index.js';

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

/** Minimal genealogy shape this predicate reads — keeps tests free of full Session fixtures. */
export type PriorityContextGenealogy =
  | {
      parent_session_id?: unknown;
      forked_from_session_id?: unknown;
    }
  | null
  | undefined;

/**
 * A session is eligible for priority-context injection only if it's a root
 * session — no parent (spawn) and no fork source. Spawned/forked/continued
 * sessions already inherit context from their parent and are out of scope
 * (see the spec's Decision 4). Combine with a first-task check (e.g.
 * `taskRepo.countBySession(id) === 0`) at the call site to also exclude a
 * root session's later turns — this predicate alone doesn't know about
 * tasks.
 */
export function isRootSessionGenealogy(genealogy: PriorityContextGenealogy): boolean {
  return !genealogy?.parent_session_id && !genealogy?.forked_from_session_id;
}

/**
 * The daemon reads manifest-listed files with its own (broader) filesystem
 * privileges, not the session creator's. That's fine for branch owners, but
 * for non-owners it would otherwise bypass filesystem access control — the
 * same effective grant that decides whether that user's own executor can
 * read the worktree at all under `insulated`/`strict` Unix isolation. Gate
 * injection on it so a non-owner denied filesystem access can't receive
 * file contents through the injected prompt instead.
 *
 * Takes `BranchRepository.resolveUserAccess(...)`'s return value directly —
 * not the branch's raw `others_fs_access` column. A user's effective access
 * can differ from that raw fallback via branch/board group grants or
 * board-aligned defaults, so passing the raw column here would both leak
 * (when a grant lowers access below the raw fallback) and over-deny (when a
 * grant raises it above).
 */
export function canInjectPriorityContextForBranch(
  access: Pick<EffectiveBranchAccess, 'is_owner' | 'fs_access'>
): boolean {
  return access.is_owner || access.fs_access !== 'none';
}

const MANIFEST_RELATIVE_PATH = path.join('.agor', 'priority-context.json');
const TODAY_TOKEN = '{today}';

/**
 * Bounds on what a manifest can pull into the first prompt of every fresh
 * root session. Without these, a manifest (accidentally oversized, or in a
 * cloned/untrusted repo) could balloon request latency, token cost, or
 * model context on the very first turn — before the agent has any chance to
 * push back, since this is injected unconditionally, not read at the
 * agent's discretion.
 */
export const MAX_MANIFEST_FILES = 20;
export const MAX_MANIFEST_BYTES = 64 * 1024; // 64 KB for the manifest JSON itself
export const MAX_FILE_BYTES = 200 * 1024; // 200 KB per file
export const MAX_TOTAL_BYTES = 512 * 1024; // 512 KB across all injected files

function isValidManifest(value: unknown): value is PriorityContextManifest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const { files, onMissing } = record;
  if (!Array.isArray(files) || !files.every((entry) => typeof entry === 'string')) return false;
  if (onMissing !== undefined && onMissing !== 'skip') return false;
  return true;
}

/**
 * Open `absolutePath` once and read at most `maxBytes` from that single
 * file descriptor — closes three gaps a separate `stat()` + `readFile()`
 * pair would leave open:
 *
 * - A regular file can grow between an initial size check and a later
 *   unbounded read. An already-open descriptor can still observe writes
 *   made after the open — the safety property isn't that the descriptor is
 *   a snapshot, it's that reading a fixed `maxBytes + 1` from it can never
 *   itself become an unbounded read, regardless of how large the file
 *   grows underneath it.
 * - A FIFO/named pipe (or other non-regular file) placed in the worktree
 *   can report a harmless size via `stat()` yet block indefinitely on
 *   `readFile()` — fatal here, since this runs inside the daemon's
 *   per-session prompt lock (`withSessionTurnLock`). `handle.stat()` on
 *   the open descriptor rejects anything that isn't a regular file before
 *   any read is attempted.
 * - Opening a FIFO with a plain read-only flag can itself block until a
 *   writer connects, before `stat()` ever runs. `O_NONBLOCK` makes the
 *   `open()` call itself return immediately instead of waiting for a
 *   writer; it has no effect on reading a regular file.
 *
 * Reads up to `maxBytes + 1` bytes, looping until EOF or the cap is hit —
 * `FileHandle.read()` is allowed to return fewer bytes than requested
 * before EOF, so a single call isn't enough to guarantee the full content
 * was read. Memory never exceeds `maxBytes + 1` bytes. Returns `undefined`
 * for anything that can't be opened or isn't a regular file (treated the
 * same as a missing file by callers); `truncated: true` when the real
 * content exceeds `maxBytes`,
 * alongside the exact number of content bytes actually accepted
 * (`bytesRead`, always `<= maxBytes`) so callers doing their own budget
 * accounting don't need to re-derive it from the decoded string (which can
 * disagree with the source byte count across a split/invalid UTF-8
 * sequence at the truncation boundary).
 */
async function readBoundedFile(
  absolutePath: string,
  maxBytes: number
): Promise<{ content: string; bytesRead: number; truncated: boolean } | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;

    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break; // EOF
      total += bytesRead;
      if (total >= buffer.length) break;
    }

    const truncated = total > maxBytes;
    const acceptedBytes = Math.min(total, maxBytes);
    return {
      content: buffer.toString('utf-8', 0, acceptedBytes),
      bytesRead: acceptedBytes,
      truncated,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read and validate `.agor/priority-context.json` from a branch's worktree.
 * Returns `undefined` if the repo hasn't opted in, the manifest is
 * missing/malformed, or it exceeds `MAX_MANIFEST_BYTES` — this feature is
 * inert by default. The size cap is enforced by `readBoundedFile` before
 * any JSON parsing, so an oversized manifest never gets fully parsed.
 */
export async function readPriorityContextManifest(
  worktreePath: string
): Promise<PriorityContextManifest | undefined> {
  const manifestPath = path.join(worktreePath, MANIFEST_RELATIVE_PATH);
  const bounded = await readBoundedFile(manifestPath, MAX_MANIFEST_BYTES);
  if (!bounded) return undefined;
  if (bounded.truncated) {
    console.warn(
      `[priority-context] Ignoring ${manifestPath}: exceeds the ${MAX_MANIFEST_BYTES}-byte manifest size limit`
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.content);
  } catch (error) {
    console.warn(`[priority-context] Failed to parse ${manifestPath}: ${(error as Error).message}`);
    return undefined;
  }

  if (!isValidManifest(parsed)) {
    console.warn(
      `[priority-context] Ignoring ${manifestPath}: expected { files: string[], onMissing?: 'skip' }`
    );
    return undefined;
  }

  if (parsed.files.length > MAX_MANIFEST_FILES) {
    console.warn(
      `[priority-context] ${manifestPath} lists ${parsed.files.length} files, ` +
        `only reading the first ${MAX_MANIFEST_FILES}`
    );
    return { ...parsed, files: parsed.files.slice(0, MAX_MANIFEST_FILES) };
  }

  return parsed;
}

function formatDateToken(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/**
 * Resolve `relativePath` against `worktreePath` and confirm the result
 * doesn't escape the worktree (`../`, an absolute path, a symlinked
 * ancestor directory, etc.), returning the *canonicalized* path that was
 * actually validated — never the unresolved lexical join — so a caller
 * that reads exactly this path isn't relying on a second, unvalidated
 * resolution.
 *
 * The manifest is repo-authored, but it's still read as plain
 * untrusted-ish data — a typo'd or malicious `../../.ssh/id_rsa` entry (or
 * a symlink swapped in under the worktree) must never turn into an
 * arbitrary host-file read.
 *
 * This walks up to the nearest ancestor that actually exists and
 * canonicalizes *that*, then re-appends the missing remainder — otherwise
 * a not-yet-existing file beneath a symlinked ancestor directory would
 * skip containment checking entirely (`fs.realpath` simply fails for a
 * path that doesn't exist, which is the common case for most manifest
 * entries). This closes the straightforward cases (final component is a
 * symlink; an ancestor directory is a symlink to outside the worktree).
 * It cannot fully close a filesystem that's concurrently and adversarially
 * modified between this check and the subsequent read (no descriptor-
 * relative/openat-style API is available via plain `node:fs/promises`) —
 * that residual TOCTOU window is accepted here, matching the trust model
 * of a manifest that already lives inside the branch's own worktree.
 *
 * Returns `undefined` for anything outside the worktree, which callers
 * treat the same as a missing file (`onMissing: 'skip'`).
 */
async function resolveWithinWorktree(
  worktreePath: string,
  relativePath: string
): Promise<string | undefined> {
  if (path.isAbsolute(relativePath)) return undefined;

  const root = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
  const lexicalCandidate = path.resolve(root, relativePath);
  if (!isContained(root, lexicalCandidate)) return undefined;

  let existingAncestor = lexicalCandidate;
  const remainder: string[] = [];
  for (;;) {
    try {
      existingAncestor = await fs.realpath(existingAncestor);
      break;
    } catch {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) return undefined; // reached filesystem root
      remainder.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  const resolved =
    remainder.length > 0 ? path.join(existingAncestor, ...remainder) : existingAncestor;
  return isContained(root, resolved) ? resolved : undefined;
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
 * Read a manifest's listed files from the worktree. Missing files, files
 * that aren't regular files (directories, FIFOs, devices, ...), and any
 * path that resolves outside the worktree, are all silently skipped —
 * `onMissing: 'skip'` is the only supported mode. Each file is read through
 * `readBoundedFile` at `min(MAX_FILE_BYTES, <remaining total budget>)`, so
 * one file can never consume more than its per-file cap, and the batch as a
 * whole can never exceed `MAX_TOTAL_BYTES`. Both a truncated (over-budget)
 * file and reaching the total budget log a warning, so a repo can tell its
 * manifest is being trimmed.
 */
export async function readPriorityContextFiles(
  worktreePath: string,
  manifest: PriorityContextManifest,
  now: Date = new Date()
): Promise<PriorityContextFile[]> {
  const results: PriorityContextFile[] = [];
  let totalBytes = 0;

  for (const rawPath of manifest.files) {
    if (totalBytes >= MAX_TOTAL_BYTES) {
      console.warn(
        `[priority-context] Reached ${MAX_TOTAL_BYTES}-byte total budget, skipping remaining files`
      );
      break;
    }

    const relativePath = await resolveTemplatedPath(worktreePath, rawPath, now);
    const safePath = await resolveWithinWorktree(worktreePath, relativePath);
    if (!safePath) {
      // resolveWithinWorktree only returns undefined for an absolute path or
      // one that escapes the worktree root — never for a merely-missing file.
      console.warn(`[priority-context] Skipping "${rawPath}": resolves outside the worktree`);
      continue;
    }

    const budget = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes);
    const bounded = await readBoundedFile(safePath, budget);
    if (!bounded) continue; // missing, unreadable, or not a regular file — onMissing: 'skip'
    if (bounded.truncated) {
      console.warn(
        `[priority-context] Skipping "${relativePath}": exceeds the ${budget}-byte read budget`
      );
      continue;
    }

    results.push({ path: relativePath, content: bounded.content });
    totalBytes += bounded.bytesRead;
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
