/**
 * useDiff — Computes diff data for rendering.
 *
 * Two tiers:
 * 1. If structuredPatch is provided (from executor enrichment), use it directly.
 * 2. Otherwise, compute a simple diffLines from old/new strings (client-side fallback).
 */

import type { StructuredPatchHunk } from '@agor/core/types';
import { diffLines, diffWords } from 'diff';
import { useMemo } from 'react';

export type { StructuredPatchHunk };

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  /** Line number in old file (context/remove lines) */
  oldLineNumber?: number;
  /** Line number in new file (context/add lines) */
  newLineNumber?: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface WordDiff {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffData {
  lines: DiffLine[];
  stats: DiffStats;
  hasLineNumbers: boolean;
  /** Total number of diff lines (for collapse decisions) */
  totalLines: number;
}

/**
 * Compute diff data from either structured patch hunks or raw old/new strings.
 */
export function useDiff(
  oldContent: string | undefined,
  newContent: string | undefined,
  structuredPatch?: StructuredPatchHunk[]
): DiffData {
  return useMemo(() => {
    // Tier 1: Use executor-provided structured patch
    if (structuredPatch?.length) {
      return fromStructuredPatch(structuredPatch);
    }

    // Tier 2: Compute client-side from old/new strings
    if (oldContent !== undefined && newContent !== undefined) {
      return fromOldNew(oldContent, newContent);
    }

    // Tier 3: All-new content (create)
    if (newContent !== undefined) {
      return fromNewOnly(newContent);
    }

    return {
      lines: [],
      stats: { additions: 0, deletions: 0 },
      hasLineNumbers: false,
      totalLines: 0,
    };
  }, [oldContent, newContent, structuredPatch]);
}

function fromStructuredPatch(hunks: StructuredPatchHunk[]): DiffData {
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];

    // Add separator between non-contiguous hunks
    if (i > 0) {
      lines.push({ type: 'context', content: '...' });
    }

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        lines.push({ type: 'add', content: line.slice(1), newLineNumber: newLine });
        newLine++;
        additions++;
      } else if (line.startsWith('-')) {
        lines.push({ type: 'remove', content: line.slice(1), oldLineNumber: oldLine });
        oldLine++;
        deletions++;
      } else {
        // Context line (starts with space or is the raw line)
        const content = line.startsWith(' ') ? line.slice(1) : line;
        lines.push({ type: 'context', content, oldLineNumber: oldLine, newLineNumber: newLine });
        oldLine++;
        newLine++;
      }
    }
  }

  return { lines, stats: { additions, deletions }, hasLineNumbers: true, totalLines: lines.length };
}

function fromOldNew(oldContent: string, newContent: string): DiffData {
  const changes = diffLines(oldContent, newContent);
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    const changeLines = change.value.replace(/\n$/, '').split('\n');
    for (const line of changeLines) {
      if (change.added) {
        lines.push({ type: 'add', content: line });
        additions++;
      } else if (change.removed) {
        lines.push({ type: 'remove', content: line });
        deletions++;
      } else {
        lines.push({ type: 'context', content: line });
      }
    }
  }

  return {
    lines,
    stats: { additions, deletions },
    hasLineNumbers: false,
    totalLines: lines.length,
  };
}

function fromNewOnly(content: string): DiffData {
  const contentLines = content.split('\n');
  const lines: DiffLine[] = contentLines.map((line, i) => ({
    type: 'add' as const,
    content: line,
    newLineNumber: i + 1,
  }));

  return {
    lines,
    stats: { additions: contentLines.length, deletions: 0 },
    hasLineNumbers: true,
    totalLines: lines.length,
  };
}

/**
 * Compute word-level diffs within a pair of removed/added lines.
 * Used for highlighting exactly what changed within a line.
 */
export function computeWordDiff(
  oldLine: string,
  newLine: string
): { old: WordDiff[]; new: WordDiff[] } {
  const changes = diffWords(oldLine, newLine);
  const oldParts: WordDiff[] = [];
  const newParts: WordDiff[] = [];

  for (const change of changes) {
    if (change.added) {
      newParts.push({ value: change.value, added: true });
    } else if (change.removed) {
      oldParts.push({ value: change.value, removed: true });
    } else {
      oldParts.push({ value: change.value });
      newParts.push({ value: change.value });
    }
  }

  return { old: oldParts, new: newParts };
}
