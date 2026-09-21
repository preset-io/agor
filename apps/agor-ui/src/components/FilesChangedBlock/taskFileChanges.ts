/**
 * Aggregates a turn's file edits.
 *
 * A task's `messages` array is already flat: a subagent's operations carry a
 * `parent_tool_use_id` but live alongside the top-level ones, so walking it
 * collects edits made inside a subagent chain without crossing any boundary.
 * Tool results are paired by id because they arrive in a later message than
 * their call.
 */

import type { DiffEnrichment, Message, StructuredPatchHunk } from '@agor-live/client';
import { countPatchStats, kindToOperationType } from '../ToolUseRenderer/renderers/DiffBlock';
import { pathsMatch } from '../ToolUseRenderer/renderers/DiffBlock/pathsMatch';

/** Tools whose calls change files on disk, across providers. */
export const FILE_EDIT_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'edit_files',
]);

export interface FileChange {
  /** One call can touch several files, so the key pairs the call with the path. */
  key: string;
  path: string;
  operation: 'edit' | 'create' | 'delete';
  structuredPatch: StructuredPatchHunk[];
  additions: number;
  deletions: number;
}

export interface TaskFileChanges {
  changes: FileChange[];
  /** Calls fully represented here; remove their calls/results at task scope. */
  toolUseIds: ReadonlySet<string>;
  /** Distinct paths touched, which is what "N files changed" counts. */
  fileCount: number;
  additions: number;
  deletions: number;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  diff?: DiffEnrichment;
}

/**
 * Whether a call's edits are represented in the turn's Files changed block.
 *
 * Enrichment is best-effort. Keep the original row (including its filename
 * fallbacks) unless every declared file can be represented here.
 */
export function hasAggregatedFileChanges(
  toolUse: Pick<ToolUseBlock, 'name' | 'input'>,
  diff: DiffEnrichment | undefined
): boolean {
  if (!FILE_EDIT_TOOLS.has(toolUse.name) || !diff) return false;
  if (toolUse.name === 'edit_files') {
    const changes = toolUse.input.changes as { path: string }[] | undefined;
    if (!changes?.length) return false;
    const unmatched = new Set(diff.files ?? []);
    // Match specific paths first and consume each diff once: foo.ts and
    // dir/foo.ts must never be considered covered by the same patch.
    return [...changes]
      .sort((a, b) => b.path.length - a.path.length)
      .every((change) => {
        const candidates = [...unmatched];
        const path = change.path.replace(/\\/g, '/');
        const file =
          candidates.find((file) => file.path.replace(/\\/g, '/') === path) ??
          candidates.find((file) => pathsMatch(file.path, change.path));
        if (!file?.structuredPatch?.length) return false;
        unmatched.delete(file);
        return true;
      });
  }
  return (
    typeof toolUse.input.file_path === 'string' &&
    toolUse.input.file_path.length > 0 &&
    !!diff.structuredPatch?.length
  );
}

function changesForToolUse(toolUse: ToolUseBlock, diff: DiffEnrichment): FileChange[] {
  const build = (
    path: string,
    operation: FileChange['operation'],
    patch: StructuredPatchHunk[],
    index: number
  ): FileChange => ({
    key: `${toolUse.id}:${index}:${path}`,
    path,
    operation,
    structuredPatch: patch,
    ...countPatchStats(patch),
  });

  if (diff.files?.length) {
    return diff.files
      .filter((file) => file.structuredPatch?.length)
      .map((file, index) =>
        build(file.path, kindToOperationType(file.kind), file.structuredPatch, index)
      );
  }

  const path = typeof toolUse.input.file_path === 'string' ? toolUse.input.file_path : '';
  if (!path || !diff.structuredPatch?.length) return [];
  return [build(path, toolUse.name === 'Write' ? 'create' : 'edit', diff.structuredPatch, 0)];
}

/** Every file a turn changed, or null when it changed none. */
export function collectFileChanges(messages: Message[]): TaskFileChanges | null {
  const resultsById = new Map<string, ToolResultBlock>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const result = block as unknown as ToolResultBlock;
        resultsById.set(result.tool_use_id, result);
      }
    }
  }

  const changes: FileChange[] = [];
  const toolUseIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const toolUse = block as unknown as ToolUseBlock;
      const diff = resultsById.get(toolUse.id)?.diff;
      if (!hasAggregatedFileChanges(toolUse, diff)) continue;
      changes.push(...changesForToolUse(toolUse, diff as DiffEnrichment));
      toolUseIds.add(toolUse.id);
    }
  }

  if (changes.length === 0) return null;

  return {
    changes,
    toolUseIds,
    fileCount: new Set(changes.map((change) => change.path)).size,
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
  };
}
