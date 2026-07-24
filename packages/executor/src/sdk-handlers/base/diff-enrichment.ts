/**
 * Diff Enrichment for Tool Results (Shared)
 *
 * Computes structuredPatch data for Edit/Write tool results at execution time.
 * This enrichment is best-effort: if it fails for any reason, the original
 * content is returned unchanged and the UI falls back to client-side diffing.
 *
 * Used by all SDK handlers (Claude, Codex, Gemini, OpenCode).
 *
 * Two usage patterns:
 *
 * 1. **Split messages** (Claude): tool_use in assistant msg, tool_result in user msg.
 *    Call `registerToolUses()` on assistant messages, then `enrichToolResults()` on
 *    the user message containing tool_results.
 *
 * 2. **Inline** (Codex, OpenCode): tool_use + tool_result in same content array.
 *    Call `enrichContentBlocks()` which finds tool_use blocks and uses their input
 *    to enrich adjacent tool_result blocks in one pass.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileDiff, StructuredPatchHunk } from '@agor/core/types';
import { structuredPatch } from 'diff';
import { createGit } from '../../git/index.js';

export type { StructuredPatchHunk } from '@agor/core/types';

/** Maximum file size we'll read for diff computation (1 MB) */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Context lines around changes (same as Claude Code CLI) */
const CONTEXT_LINES = 3;
/** Maximum diff lines to persist per file in message JSON. */
const MAX_STORED_DIFF_LINES_PER_FILE = 200;
/** Maximum repo files to snapshot at the start of a Codex turn. */
const MAX_TURN_BASELINE_FILES = 5_000;
/** Maximum aggregate text bytes to keep in a Codex turn baseline. */
const MAX_TURN_BASELINE_BYTES = 25 * 1_048_576;

interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

export interface DiffEnrichmentContext {
  workingDirectory?: string;
  snapshotScope?: string;
}

export interface FileChangeSpec {
  path: string;
  kind?: string;
}

interface EditFilesSnapshot {
  path: string;
  kind: 'add' | 'update' | 'delete';
  absolutePath: string;
  beforeExists: boolean;
  beforeContent?: string;
}

interface PendingSnapshotEntry {
  snapshots: EditFilesSnapshot[];
  createdAt: number;
}

interface TextFileSnapshot {
  exists: boolean;
  content?: string;
  skipped?: boolean;
}

interface EditFilesBaselineEntry {
  gitRoot: string;
  files: Map<string, TextFileSnapshot>;
  fileListComplete: boolean;
  createdAt: number;
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

function isSafeRepoRelativePath(relativePath: string): boolean {
  const normalized = path.posix.normalize(relativePath.split(path.sep).join('/'));
  return !(
    !normalized ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('\0') ||
    normalized.includes('\n') ||
    normalized.includes('\r')
  );
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function readTextFileSnapshot(absolutePath: string): TextFileSnapshot {
  try {
    const linkStat = fs.lstatSync(absolutePath);
    if (!linkStat.isFile()) {
      return { exists: true, skipped: true };
    }
    const stat = fs.statSync(absolutePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return { exists: true, skipped: true };
    }
    const buffer = fs.readFileSync(absolutePath);
    // Avoid rendering binary data as a giant mojibake text diff.
    if (buffer.includes(0)) {
      return { exists: true, skipped: true };
    }
    return { exists: true, content: buffer.toString('utf-8') };
  } catch {
    return { exists: false };
  }
}

function getGitRoot(workingDirectory?: string): string | null {
  let current = path.resolve(workingDirectory ?? process.cwd());

  try {
    const stat = fs.statSync(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function getGitRootFromGit(workingDirectory: string): Promise<string | null> {
  try {
    const { git } = createGit(workingDirectory);
    const gitRoot = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    return gitRoot || null;
  } catch {
    return null;
  }
}

async function listTurnBaselineFiles(
  gitRoot: string
): Promise<{ files: string[]; complete: boolean }> {
  try {
    const { git } = createGit(gitRoot);
    const output = await git.raw(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const files: string[] = [];
    const seen = new Set<string>();

    for (const rawPath of output.split('\0')) {
      if (!rawPath || seen.has(rawPath) || !isSafeRepoRelativePath(rawPath)) continue;
      if (files.length >= MAX_TURN_BASELINE_FILES) {
        return { files, complete: false };
      }
      seen.add(rawPath);
      files.push(rawPath);
    }

    return { files, complete: true };
  } catch {
    return { files: [], complete: false };
  }
}

/**
 * Resolve a path to a git-repo-relative path, tolerating symlink prefix drift.
 *
 * In production we may receive absolute tool paths under a symlinked mount
 * while git reports a canonical root under a different prefix. This helper
 * tries lexical and canonicalized candidates and returns a safe repo-relative path.
 */
function resolveRepoRelativePath(gitRoot: string, absolutePath: string): string | null {
  const lexicalRelative = path.relative(gitRoot, absolutePath);
  if (isSafeRepoRelativePath(lexicalRelative)) {
    return lexicalRelative;
  }

  const gitRootReal = tryRealpath(gitRoot);
  if (!gitRootReal) return null;

  const candidates = new Set<string>();
  candidates.add(absolutePath);

  const absoluteReal = tryRealpath(absolutePath);
  if (absoluteReal) {
    candidates.add(absoluteReal);
  } else {
    // File may not exist (e.g., delete). Resolve through parent directory.
    const parentReal = tryRealpath(path.dirname(absolutePath));
    if (parentReal) {
      candidates.add(path.join(parentReal, path.basename(absolutePath)));
    }
  }

  for (const candidate of candidates) {
    const relativePath = path.relative(gitRootReal, candidate);
    if (isSafeRepoRelativePath(relativePath)) {
      return relativePath;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pattern 1: Split messages (Claude)
// ---------------------------------------------------------------------------

/**
 * In-memory map of recent tool_use IDs → their input.
 * Populated when assistant messages with tool_use blocks are processed,
 * consumed when the corresponding tool_result arrives.
 *
 * Entries are deleted after consumption to avoid unbounded growth.
 */
const pendingToolUses = new Map<string, ToolUseInfo>();
const pendingEditFilesSnapshots = new Map<string, PendingSnapshotEntry>();
const pendingEditFilesBaselines = new Map<string, EditFilesBaselineEntry>();
const MAX_PENDING_EDIT_FILES_SNAPSHOTS = 400;

/**
 * Register tool uses from an assistant message for later enrichment lookup.
 * Used when tool_use and tool_result are in separate messages (Claude pattern).
 */
export function registerToolUses(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
): void {
  for (const tu of toolUses) {
    pendingToolUses.set(tu.id, { name: tu.name, input: tu.input });
  }
}

/**
 * Register a pre-edit snapshot for tools that need true pre/post diffs.
 * Currently used for Codex edit_files at tool-start time so completion does not
 * rely on git HEAD state.
 */
export function registerToolInvocationStart(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: DiffEnrichmentContext
): void {
  try {
    if (toolName.toLowerCase() !== 'edit_files') return;

    const changes = toolInput.changes as FileChangeSpec[] | undefined;
    if (!changes || changes.length === 0) return;

    const workingDirectory = context?.workingDirectory;
    const gitRoot = getGitRoot(workingDirectory);
    if (!gitRoot) return;

    const snapshots: EditFilesSnapshot[] = [];
    for (const change of changes) {
      if (!change?.path) continue;

      const kind = normalizeChangeKind(change.kind);
      const absolutePath = path.isAbsolute(change.path)
        ? change.path
        : path.resolve(workingDirectory || gitRoot, change.path);

      // Only snapshot files inside the repo.
      if (!resolveRepoRelativePath(gitRoot, absolutePath)) continue;

      const before = readTextFileSnapshot(absolutePath);

      snapshots.push({
        path: change.path,
        kind,
        absolutePath,
        beforeExists: before.exists,
        beforeContent: before.content,
      });
    }

    if (snapshots.length > 0) {
      pendingEditFilesSnapshots.set(getSnapshotKey(toolUseId, context), {
        snapshots,
        createdAt: Date.now(),
      });
    }

    pruneOldestEditFilesSnapshots();
  } catch {
    // Best effort — swallow any errors
  }
}

/**
 * Clear pending per-invocation snapshot state for a specific tool use.
 * Used on terminal paths (stop/abort/error) to prevent stale cache buildup.
 */
export function clearToolInvocationState(toolUseId: string, context?: DiffEnrichmentContext): void {
  pendingEditFilesSnapshots.delete(getSnapshotKey(toolUseId, context));
}

/**
 * Capture a best-effort in-memory repo baseline at the start of a Codex turn.
 *
 * Codex SDK 0.135 emits `file_change` items only after the patch has been
 * applied, so there is no per-file `tool_start` moment with target paths for
 * edit_files. This turn baseline gives edit_files a true pre-image for dirty
 * tracked and untracked files without falling back to git HEAD. The baseline is
 * updated after each edit_files result so multiple edits to the same file in one
 * turn render as per-operation diffs.
 */
export async function registerEditFilesTurnBaseline(
  context?: DiffEnrichmentContext
): Promise<void> {
  try {
    const workingDirectory = context?.workingDirectory;
    if (!workingDirectory) return;

    const gitRoot = await getGitRootFromGit(workingDirectory);
    if (!gitRoot) return;

    const listedFiles = await listTurnBaselineFiles(gitRoot);
    const files = new Map<string, TextFileSnapshot>();
    let totalBytes = 0;
    for (const relativePath of listedFiles.files) {
      const absolutePath = path.join(gitRoot, relativePath);
      const snapshot = readTextFileSnapshot(absolutePath);
      if (snapshot.content !== undefined) {
        const byteLength = Buffer.byteLength(snapshot.content, 'utf-8');
        if (totalBytes + byteLength > MAX_TURN_BASELINE_BYTES) {
          files.set(relativePath, { exists: true, skipped: true });
          continue;
        }
        totalBytes += byteLength;
      }
      files.set(relativePath, snapshot);
    }

    pendingEditFilesBaselines.set(getBaselineKey(context), {
      gitRoot,
      files,
      fileListComplete: listedFiles.complete,
      createdAt: Date.now(),
    });
  } catch {
    // Best effort — swallow any errors.
  }
}

/**
 * Refresh an existing turn baseline after a non-edit_files tool that may have
 * mutated the worktree. This keeps later edit_files diffs scoped to their own
 * operation instead of diffing against the beginning of the whole Codex turn.
 */
export async function refreshEditFilesTurnBaseline(context?: DiffEnrichmentContext): Promise<void> {
  if (!pendingEditFilesBaselines.has(getBaselineKey(context))) return;
  await registerEditFilesTurnBaseline(context);
}

export function clearEditFilesTurnBaseline(context?: DiffEnrichmentContext): void {
  pendingEditFilesBaselines.delete(getBaselineKey(context));
}

/**
 * Enrich tool_result content blocks using previously registered tool_use data.
 * Used when tool_use and tool_result are in separate messages (Claude pattern).
 *
 * Mutates content blocks in-place by adding a `diff` field.
 * Best-effort: any failure silently falls through.
 */
export function enrichToolResults(contentBlocks: ContentBlock[]): void {
  for (const block of contentBlocks) {
    if (block.type !== 'tool_result' || block.is_error) continue;

    const toolUseId = block.tool_use_id;
    if (!toolUseId) continue;

    const toolUse = pendingToolUses.get(toolUseId);
    if (!toolUse) continue;

    // Consume the entry — we no longer need it
    pendingToolUses.delete(toolUseId);

    enrichBlock(block, toolUse.name, toolUse.input, undefined, toolUseId);
  }

  // GC: clear any stale entries older than expected
  if (pendingToolUses.size > 200) {
    pendingToolUses.clear();
  }
}

// ---------------------------------------------------------------------------
// Pattern 2: Inline (Codex, OpenCode, Gemini)
// ---------------------------------------------------------------------------

/**
 * Enrich content blocks where tool_use and tool_result appear in the same array.
 * Scans for tool_use blocks, builds a local map, then enriches matching tool_results.
 *
 * Used by Codex, OpenCode, and Gemini handlers.
 * Mutates content blocks in-place. Best-effort.
 */
export function enrichContentBlocks(
  contentBlocks: ContentBlock[],
  context?: DiffEnrichmentContext
): void {
  // Build local map from tool_use blocks in this array
  const localToolUses = new Map<string, ToolUseInfo>();
  for (const block of contentBlocks) {
    if (block.type === 'tool_use' && block.id && block.name && block.input) {
      localToolUses.set(block.id, { name: block.name, input: block.input });
    }
  }

  if (localToolUses.size === 0) return;

  // Enrich tool_result blocks
  for (const block of contentBlocks) {
    if (block.type !== 'tool_result' || block.is_error) continue;

    const toolUseId = block.tool_use_id;
    if (!toolUseId) continue;

    const toolUse = localToolUses.get(toolUseId);
    if (!toolUse) continue;

    enrichBlock(block, toolUse.name, toolUse.input, context, toolUseId);
  }
}

// ---------------------------------------------------------------------------
// Core enrichment logic (shared)
// ---------------------------------------------------------------------------

/**
 * Enrich a single tool_result block with diff data.
 * Best-effort — swallows all errors.
 */
function enrichBlock(
  block: ContentBlock,
  toolName: string,
  toolInput: Record<string, unknown>,
  context?: DiffEnrichmentContext,
  toolUseId?: string
): void {
  try {
    // Normalize tool names across SDKs (Claude: "Edit", Codex: "edit", etc.)
    const normalized = toolName.toLowerCase();
    if (normalized === 'edit') {
      enrichEditResult(block, toolInput);
    } else if (normalized === 'write') {
      enrichWriteResult(block, toolInput);
    } else if (normalized === 'edit_files') {
      enrichEditFilesResult(block, toolInput, context, toolUseId);
    }
  } catch {
    // Best effort — swallow any errors
  }
}

function countOldLines(lines: string[]): number {
  return lines.filter((line) => !line.startsWith('+')).length;
}

function countNewLines(lines: string[]): number {
  return lines.filter((line) => !line.startsWith('-')).length;
}

function truncateStructuredPatchHunks(hunks: StructuredPatchHunk[]): StructuredPatchHunk[] {
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (totalLines <= MAX_STORED_DIFF_LINES_PER_FILE) return hunks;

  const truncated: StructuredPatchHunk[] = [];
  let remaining = MAX_STORED_DIFF_LINES_PER_FILE;
  let shownLines = 0;

  for (const hunk of hunks) {
    if (remaining <= 0) break;

    const lines = hunk.lines.slice(0, remaining);
    remaining -= lines.length;
    shownLines += lines.length;

    truncated.push({
      ...hunk,
      oldLines: countOldLines(lines),
      newLines: countNewLines(lines),
      lines,
    });
  }

  const notice = ` [diff output was truncated: showing first ${shownLines} of ${totalLines} lines]`;
  const lastHunk = truncated.at(-1);
  if (lastHunk) {
    lastHunk.lines = [...lastHunk.lines, notice];
    lastHunk.oldLines = countOldLines(lastHunk.lines);
    lastHunk.newLines = countNewLines(lastHunk.lines);
  }

  return truncated;
}

/**
 * Compute structuredPatch for an Edit tool result.
 *
 * Strategy: The SDK has already applied the edit. We read the current file
 * (post-edit) and reverse the replacement to reconstruct pre-edit content,
 * then diff the two.
 */
function enrichEditResult(block: ContentBlock, input: Record<string, unknown>): void {
  const filePath = input.file_path as string | undefined;
  const oldString = input.old_string as string | undefined;
  const newString = input.new_string as string | undefined;
  const replaceAll = (input.replace_all as boolean) ?? false;

  if (!filePath || oldString === undefined || newString === undefined) return;

  // Skip large files
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) return;

  // Read current file (post-edit)
  let currentContent: string | null = fs.readFileSync(filePath, 'utf-8');

  // Reconstruct pre-edit content by reversing the replacement.
  // Special case: when newString is empty (a deletion), indexOf('') always returns 0
  // and replaceAll('', ...) inserts between every character — both are wrong.
  // In that case, skip reverse reconstruction and diff old_string vs new_string directly.
  let preEditContent: string | null;
  if (newString === '') {
    // Deletion — can't reliably reverse-locate where the deletion happened in the file
    preEditContent = null;
  } else if (replaceAll) {
    // replace_all: can't reliably reverse — newString may appear in unrelated parts of
    // the file, so replaceAll(newString, oldString) would corrupt those sections.
    // Fall back to diffing old_string vs new_string directly.
    preEditContent = null;
  } else {
    // Reverse first occurrence
    const idx = currentContent.indexOf(newString);
    if (idx === -1) {
      // Can't reconstruct — newString not found (maybe another edit happened since)
      // Fall back to just diffing old_string vs new_string directly
      preEditContent = null;
    } else {
      preEditContent =
        currentContent.slice(0, idx) + oldString + currentContent.slice(idx + newString.length);
    }
  }

  let hunks: StructuredPatchHunk[];
  if (preEditContent !== null) {
    // Full-file diff with context
    const patch = structuredPatch(filePath, filePath, preEditContent, currentContent, '', '', {
      context: CONTEXT_LINES,
    });
    hunks = patch.hunks;
    // Release file strings immediately
    preEditContent = null;
  } else {
    // Fallback: diff just the old/new strings (no line numbers from file, but still structured)
    const patch = structuredPatch(filePath, filePath, oldString, newString, '', '', {
      context: CONTEXT_LINES,
    });
    hunks = patch.hunks;
  }

  // Release current content
  currentContent = null;

  hunks = truncateStructuredPatchHunks(hunks);
  if (hunks.length > 0) {
    block.diff = { structuredPatch: hunks };
  }
}

/**
 * Compute structuredPatch for a Write tool result.
 *
 * For new files, all content is additions (no pre-edit content).
 * For overwrites, we'd need the original — but we don't have it post-write.
 * So for Write we just mark it as a create with the content length.
 */
function enrichWriteResult(block: ContentBlock, input: Record<string, unknown>): void {
  const filePath = input.file_path as string | undefined;
  const content = input.content as string | undefined;

  if (!filePath || content === undefined) return;

  // For Write tool, we don't know the previous content (it's been overwritten).
  // Create a simple "all additions" patch.
  const patch = structuredPatch(filePath, filePath, '', content, '', '', {
    context: 0,
  });

  const hunks = truncateStructuredPatchHunks(patch.hunks);
  if (hunks.length > 0) {
    block.diff = { structuredPatch: hunks };
  }
}

/**
 * Compute structuredPatch for Codex edit_files tool results.
 *
 * Codex groups file changes as: { changes: [{ path, kind }] }.
 * No old/new content is provided. Prefer pre-edit snapshots captured at
 * tool-start. If no snapshot exists, only explicit add operations can be
 * represented accurately; updates/deletes are left unenriched rather than
 * guessed from git HEAD, which may be stale relative to a dirty worktree.
 */
function enrichEditFilesResult(
  block: ContentBlock,
  input: Record<string, unknown>,
  context?: DiffEnrichmentContext,
  toolUseId?: string
): void {
  const changes = input.changes as FileChangeSpec[] | undefined;
  if (!changes || changes.length === 0) return;
  const workingDirectory = context?.workingDirectory;

  const snapshotEntry = toolUseId
    ? pendingEditFilesSnapshots.get(getSnapshotKey(toolUseId, context))
    : undefined;
  if (toolUseId) {
    pendingEditFilesSnapshots.delete(getSnapshotKey(toolUseId, context));
  }
  const snapshots = snapshotEntry?.snapshots;
  const baselineSnapshots = snapshotsFromEditFilesBaseline(changes, context);
  const baseline = pendingEditFilesBaselines.get(getBaselineKey(context));
  const gitRoot = baseline?.gitRoot ?? getGitRoot(workingDirectory);
  if (!gitRoot) return; // Not in a git repo or git unavailable

  const invocationSnapshotsByPath = new Map<string, EditFilesSnapshot>();
  for (const snapshot of snapshots ?? []) {
    const relativePath = resolveRepoRelativePath(gitRoot, snapshot.absolutePath);
    if (relativePath) invocationSnapshotsByPath.set(relativePath, snapshot);
  }

  const baselineSnapshotsByPath = new Map<string, EditFilesSnapshot>();
  for (const snapshot of baselineSnapshots) {
    const relativePath = resolveRepoRelativePath(gitRoot, snapshot.absolutePath);
    if (relativePath) baselineSnapshotsByPath.set(relativePath, snapshot);
  }

  const fileDiffs: FileDiff[] = [];
  const refreshSnapshots: EditFilesSnapshot[] = [];
  const processedPaths = new Set<string>();

  for (const change of changes) {
    if (!change.path) continue;

    const kind = normalizeChangeKind(change.kind);
    const filePath = change.path;
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workingDirectory || gitRoot, filePath);
    const relativePath = resolveRepoRelativePath(gitRoot, resolvedPath);
    if (!relativePath || processedPaths.has(relativePath)) continue;
    processedPaths.add(relativePath);

    const invocationSnapshot = invocationSnapshotsByPath.get(relativePath);
    const baselineSnapshot = baselineSnapshotsByPath.get(relativePath);
    const refreshSnapshot = baselineSnapshot ??
      invocationSnapshot ?? {
        path: relativePath,
        kind,
        absolutePath: resolvedPath,
        beforeExists: false,
      };
    refreshSnapshots.push(refreshSnapshot);

    // Resolve each file independently. A multi-file item can be observed while
    // Codex is between mutations, leaving some invocation snapshots pre-edit
    // and others post-edit. Prefer a valid invocation diff for this path, then
    // fall back to the turn baseline only for this path.
    const invocationDiff = invocationSnapshot
      ? enrichFromEditFilesSnapshots([invocationSnapshot])[0]
      : undefined;
    if (invocationDiff) {
      fileDiffs.push(invocationDiff);
      continue;
    }

    const baselineDiff = baselineSnapshot
      ? enrichFromEditFilesSnapshots([baselineSnapshot])[0]
      : undefined;
    if (baselineDiff) {
      fileDiffs.push(baselineDiff);
      continue;
    }

    // Without a pre-edit snapshot, Codex SDK file_change items only tell us
    // path + kind. Diffing updates/deletes against HEAD is misleading in dirty
    // worktrees (e.g. files created or modified by earlier uncommitted tool
    // calls can appear as whole-file additions). Only an explicit add has a
    // trustworthy post-edit-only representation.
    if (kind !== 'add') continue;

    try {
      const after = readTextFileSnapshot(resolvedPath);
      if (!after.exists || after.content === undefined) continue;
      const content = after.content;
      const patch = structuredPatch(filePath, filePath, '', content, '', '', {
        context: 0,
      });
      const hunks = truncateStructuredPatchHunks(patch.hunks);
      if (hunks.length > 0) {
        fileDiffs.push({ path: filePath, kind, structuredPatch: hunks });
      }
    } catch {
      // Best effort — skip files that fail
    }
  }

  // Advance the baseline once, after every file has been compared against its
  // chosen pre-image. This prevents one path's late snapshot from destroying
  // another path's still-needed turn baseline.
  refreshEditFilesBaselineFromSnapshots(context, refreshSnapshots);

  if (fileDiffs.length > 0) {
    // Also set structuredPatch to the first file's hunks for backward compat
    block.diff = {
      structuredPatch: fileDiffs[0].structuredPatch,
      files: fileDiffs,
    };
  }
}

function normalizeChangeKind(kind: string | undefined): 'add' | 'update' | 'delete' {
  if (kind === 'add' || kind === 'delete' || kind === 'update') {
    return kind;
  }
  return 'update';
}

function getSnapshotKey(toolUseId: string, context?: DiffEnrichmentContext): string {
  return `${context?.snapshotScope ?? 'global'}:${toolUseId}`;
}

function getBaselineKey(context?: DiffEnrichmentContext): string {
  return context?.snapshotScope ?? 'global';
}

function pruneOldestEditFilesSnapshots(): void {
  if (pendingEditFilesSnapshots.size <= MAX_PENDING_EDIT_FILES_SNAPSHOTS) return;

  const overflowCount = pendingEditFilesSnapshots.size - MAX_PENDING_EDIT_FILES_SNAPSHOTS;
  const oldestKeys = [...pendingEditFilesSnapshots.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, overflowCount)
    .map(([key]) => key);

  for (const key of oldestKeys) {
    pendingEditFilesSnapshots.delete(key);
  }
}

function enrichFromEditFilesSnapshots(snapshots: EditFilesSnapshot[]): FileDiff[] {
  const fileDiffs: FileDiff[] = [];

  for (const snapshot of snapshots) {
    try {
      const after = readTextFileSnapshot(snapshot.absolutePath);
      const afterExists = after.exists;

      // Existing but skipped means large/binary/non-regular. Avoid false full-file
      // add/delete/update diffs from an unknown side of the comparison.
      if (
        (snapshot.beforeExists && snapshot.beforeContent === undefined) ||
        (afterExists && after.content === undefined)
      ) {
        continue;
      }

      const beforeForDiff = snapshot.beforeExists ? (snapshot.beforeContent ?? '') : '';
      const afterForDiff = afterExists ? (after.content ?? '') : '';
      if (!snapshot.beforeExists && !afterExists) continue;
      if (beforeForDiff === afterForDiff) continue;

      let resultKind: 'add' | 'update' | 'delete' = snapshot.kind;
      if (!snapshot.beforeExists && afterExists) {
        resultKind = 'add';
      } else if (snapshot.beforeExists && !afterExists) {
        resultKind = 'delete';
      } else {
        resultKind = 'update';
      }

      const patch = structuredPatch(
        snapshot.path,
        snapshot.path,
        beforeForDiff,
        afterForDiff,
        '',
        '',
        {
          context: resultKind === 'add' ? 0 : CONTEXT_LINES,
        }
      );

      const hunks = truncateStructuredPatchHunks(patch.hunks);
      if (hunks.length > 0) {
        fileDiffs.push({
          path: snapshot.path,
          kind: resultKind,
          structuredPatch: hunks,
        });
      }
    } catch {
      // Best effort — skip files that fail
    }
  }

  // Keep fallback path in calling method if this yields no diffs.
  return fileDiffs;
}

function snapshotsFromEditFilesBaseline(
  changes: FileChangeSpec[],
  context?: DiffEnrichmentContext
): EditFilesSnapshot[] {
  const baseline = pendingEditFilesBaselines.get(getBaselineKey(context));
  if (!baseline) return [];

  const snapshots: EditFilesSnapshot[] = [];
  for (const change of changes) {
    if (!change?.path) continue;

    const absolutePath = path.isAbsolute(change.path)
      ? change.path
      : path.resolve(context?.workingDirectory || baseline.gitRoot, change.path);
    const relativePath = resolveRepoRelativePath(baseline.gitRoot, absolutePath);
    if (!relativePath) continue;

    const before = baseline.files.get(relativePath);
    if (!before && !baseline.fileListComplete) {
      // An absent entry is only authoritative when enumeration completed. If
      // capture hit its file cap or failed, the path may already have existed.
      // Omitting an uncertain diff is safer than fabricating a whole-file add.
      continue;
    }
    snapshots.push({
      path: relativePath,
      kind: normalizeChangeKind(change.kind),
      absolutePath,
      beforeExists: before?.exists ?? false,
      beforeContent: before?.content,
    });
  }

  return snapshots;
}

function refreshEditFilesBaselineFromSnapshots(
  context: DiffEnrichmentContext | undefined,
  snapshots: EditFilesSnapshot[]
): void {
  const baseline = pendingEditFilesBaselines.get(getBaselineKey(context));
  if (!baseline) return;

  for (const snapshot of snapshots) {
    const relativePath = resolveRepoRelativePath(baseline.gitRoot, snapshot.absolutePath);
    if (!relativePath) continue;

    const after = readTextFileSnapshot(snapshot.absolutePath);
    if (!after.exists) {
      baseline.files.delete(relativePath);
      continue;
    }

    baseline.files.set(relativePath, after);
  }
}
