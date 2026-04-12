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

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileDiff, StructuredPatchHunk } from '@agor/core/types';
import { structuredPatch } from 'diff';

export type { StructuredPatchHunk } from '@agor/core/types';

/** Maximum file size we'll read for diff computation (1 MB) */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Context lines around changes (same as Claude Code CLI) */
const CONTEXT_LINES = 3;

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
    let gitRoot: string;
    try {
      gitRoot = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        timeout: 5000,
        ...(workingDirectory ? { cwd: workingDirectory } : {}),
      }).trim();
    } catch {
      return;
    }

    const snapshots: EditFilesSnapshot[] = [];
    for (const change of changes) {
      if (!change?.path) continue;

      const kind = normalizeChangeKind(change.kind);
      const absolutePath = path.isAbsolute(change.path)
        ? change.path
        : path.resolve(workingDirectory || gitRoot, change.path);

      // Only snapshot files inside the repo.
      if (!resolveRepoRelativePath(gitRoot, absolutePath)) continue;

      let beforeExists = false;
      let beforeContent: string | undefined;
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size <= MAX_FILE_SIZE_BYTES) {
          beforeContent = fs.readFileSync(absolutePath, 'utf-8');
        }
        beforeExists = true;
      } catch {
        beforeExists = false;
      }

      snapshots.push({
        path: change.path,
        kind,
        absolutePath,
        beforeExists,
        beforeContent,
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

  if (patch.hunks.length > 0) {
    block.diff = { structuredPatch: patch.hunks };
  }
}

/**
 * Compute structuredPatch for Codex edit_files tool results.
 *
 * Codex groups file changes as: { changes: [{ path, kind }] }.
 * No old/new content is provided — we reconstruct diffs by comparing
 * the current file (post-edit) against git HEAD.
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

  if (snapshots?.length) {
    const snapshotDiffs = enrichFromEditFilesSnapshots(snapshots);
    if (snapshotDiffs.length > 0) {
      block.diff = {
        structuredPatch: snapshotDiffs[0].structuredPatch,
        files: snapshotDiffs,
      };
      return;
    }
  }

  // Find git root once for relative path resolution
  let gitRoot: string;
  try {
    gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 5000,
      ...(workingDirectory ? { cwd: workingDirectory } : {}),
    }).trim();
  } catch {
    return; // Not in a git repo or git unavailable
  }

  const fileDiffs: FileDiff[] = [];

  for (const change of changes) {
    if (!change.path) continue;

    const kind = normalizeChangeKind(change.kind);
    const filePath = change.path;
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workingDirectory || gitRoot, filePath);

    try {
      if (kind === 'add') {
        // New file — all additions
        const stat = fs.statSync(resolvedPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const patch = structuredPatch(filePath, filePath, '', content, '', '', {
          context: 0,
        });
        if (patch.hunks.length > 0) {
          fileDiffs.push({ path: filePath, kind, structuredPatch: patch.hunks });
        }
      } else if (kind === 'delete') {
        // Deleted file — get old content from git
        const relativePath = resolveRepoRelativePath(gitRoot, resolvedPath);
        if (!relativePath) continue;
        const oldContent = gitShowHeadFile(gitRoot, relativePath);
        if (oldContent === null) continue;
        const patch = structuredPatch(filePath, filePath, oldContent, '', '', '', {
          context: CONTEXT_LINES,
        });
        if (patch.hunks.length > 0) {
          fileDiffs.push({ path: filePath, kind, structuredPatch: patch.hunks });
        }
      } else {
        // Update — diff git HEAD vs current file
        const stat = fs.statSync(resolvedPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        const currentContent = fs.readFileSync(resolvedPath, 'utf-8');
        const relativePath = resolveRepoRelativePath(gitRoot, resolvedPath);
        if (!relativePath) continue;
        const oldContent = gitShowHeadFile(gitRoot, relativePath);
        if (oldContent === null) {
          // File may be new (not in HEAD) — treat as addition
          const patch = structuredPatch(filePath, filePath, '', currentContent, '', '', {
            context: 0,
          });
          if (patch.hunks.length > 0) {
            fileDiffs.push({ path: filePath, kind: 'add', structuredPatch: patch.hunks });
          }
          continue;
        }
        const patch = structuredPatch(filePath, filePath, oldContent, currentContent, '', '', {
          context: CONTEXT_LINES,
        });
        if (patch.hunks.length > 0) {
          fileDiffs.push({ path: filePath, kind, structuredPatch: patch.hunks });
        }
      }
    } catch {
      // Best effort — skip files that fail
    }
  }

  if (fileDiffs.length > 0) {
    // Also set structuredPatch to the first file's hunks for backward compat
    block.diff = {
      structuredPatch: fileDiffs[0].structuredPatch,
      files: fileDiffs,
    };
  }
}

function gitShowHeadFile(gitRoot: string, relativePath: string): string | null {
  // Ensure the ref path is safe and uses git's forward-slash separator.
  const normalized = path.posix.normalize(relativePath.split(path.sep).join('/'));
  if (!isSafeRepoRelativePath(normalized)) {
    return null;
  }

  try {
    return execFileSync('git', ['show', `HEAD:${normalized}`], {
      encoding: 'utf-8',
      timeout: 5000,
      cwd: gitRoot,
    });
  } catch {
    return null;
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
      let afterExists = false;
      let afterContent = '';

      try {
        const stat = fs.statSync(snapshot.absolutePath);
        if (stat.size <= MAX_FILE_SIZE_BYTES) {
          afterContent = fs.readFileSync(snapshot.absolutePath, 'utf-8');
        }
        afterExists = true;
      } catch {
        afterExists = false;
      }

      const beforeContent = snapshot.beforeExists ? (snapshot.beforeContent ?? '') : '';
      const beforeForDiff = snapshot.beforeExists ? beforeContent : '';
      const afterForDiff = afterExists ? afterContent : '';
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

      if (patch.hunks.length > 0) {
        fileDiffs.push({
          path: snapshot.path,
          kind: resultKind,
          structuredPatch: patch.hunks,
        });
      }
    } catch {
      // Best effort — skip files that fail
    }
  }

  // Keep fallback path in calling method if this yields no diffs.
  return fileDiffs;
}
