/**
 * Diff Enrichment for Tool Results
 *
 * Computes structuredPatch data for Edit/Write tool results at execution time.
 * This enrichment is best-effort: if it fails for any reason, the original
 * content is returned unchanged and the UI falls back to client-side diffing.
 *
 * Inspired by how Claude Code CLI generates diffs internally — using the `diff`
 * library's structuredPatch() against the file content, not `git diff`.
 */

import * as fs from 'node:fs';
import { structuredPatch } from 'diff';

/** Maximum file size we'll read for diff computation (1 MB) */
const MAX_FILE_SIZE_BYTES = 1_048_576;

/** Context lines around changes (same as Claude Code CLI) */
const CONTEXT_LINES = 3;

interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

interface ContentBlock {
  type: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * In-memory map of recent tool_use IDs → their input.
 * Populated when assistant messages with tool_use blocks are processed,
 * consumed when the corresponding tool_result arrives.
 *
 * Entries are deleted after consumption to avoid unbounded growth.
 */
const pendingToolUses = new Map<string, ToolUseInfo>();

/**
 * Register tool uses from an assistant message for later enrichment lookup.
 * Call this when processing assistant 'complete' events that contain toolUses.
 */
export function registerToolUses(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
): void {
  for (const tu of toolUses) {
    pendingToolUses.set(tu.id, { name: tu.name, input: tu.input });
  }
}

/**
 * Enrich tool_result content blocks with structuredPatch diff data.
 * Mutates the content blocks in-place by adding a `diff` field.
 *
 * Best-effort: any failure silently falls through, leaving the block unchanged.
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

    try {
      if (toolUse.name === 'Edit') {
        enrichEditResult(block, toolUse.input);
      } else if (toolUse.name === 'Write') {
        enrichWriteResult(block, toolUse.input);
      }
    } catch {
      // Best effort — swallow any errors
    }
  }

  // GC: clear any stale entries older than expected (shouldn't happen,
  // but prevents unbounded growth if tool_results are lost)
  if (pendingToolUses.size > 200) {
    pendingToolUses.clear();
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

  // Reconstruct pre-edit content by reversing the replacement
  let preEditContent: string | null;
  if (replaceAll) {
    preEditContent = currentContent.replaceAll(newString, oldString);
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

  if (!filePath || !content) return;

  // For Write tool, we don't know the previous content (it's been overwritten).
  // Create a simple "all additions" patch.
  const patch = structuredPatch(filePath, filePath, '', content, '', '', {
    context: 0,
  });

  if (patch.hunks.length > 0) {
    block.diff = { structuredPatch: patch.hunks };
  }
}
