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
 * Enrichment is best-effort, so an edit without a patch has nothing to show
 * there and stays an ordinary activity row instead of vanishing.
 */
export function hasAggregatedFileChanges(
  toolName: string,
  diff: DiffEnrichment | undefined
): boolean {
  if (!FILE_EDIT_TOOLS.has(toolName) || !diff) return false;
  return diff.files?.length
    ? diff.files.some((file) => file.structuredPatch?.length)
    : !!diff.structuredPatch?.length;
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
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const toolUse = block as unknown as ToolUseBlock;
      const diff = resultsById.get(toolUse.id)?.diff;
      if (!hasAggregatedFileChanges(toolUse.name, diff)) continue;
      changes.push(...changesForToolUse(toolUse, diff as DiffEnrichment));
    }
  }

  if (changes.length === 0) return null;

  return {
    changes,
    fileCount: new Set(changes.map((change) => change.path)).size,
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
  };
}
