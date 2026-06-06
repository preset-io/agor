import { createHash } from 'node:crypto';
import type { KnowledgeEditOp } from '../types/knowledge.js';

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function splitLines(text: string): string[] {
  if (text === '') return [''];
  return normalizeNewlines(text).split('\n');
}

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function joinLines(lines: string[]): string {
  if (lines.length === 0) return '';
  // Preserve trailing empty line (which represents trailing newline)
  const content = lines.join('\n');
  return content;
}

function toLineRangeString(lines: string[]): string {
  return joinLines(lines);
}

class KnowledgeEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeEditError';
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new KnowledgeEditError(message);
}

function applyReplaceLineRange(
  lines: string[],
  op: Extract<KnowledgeEditOp, { type: 'replace_line_range' }>
): void {
  const { startLine, endLine } = op;
  assert(
    Number.isInteger(startLine) && startLine >= 1,
    'replace_line_range.startLine must be >= 1'
  );
  assert(
    Number.isInteger(endLine) && endLine >= startLine,
    'replace_line_range.endLine must be >= startLine'
  );
  assert(endLine <= lines.length, 'replace_line_range range exceeds document length');

  const startIdx = startLine - 1;
  const deleteCount = endLine - startLine + 1;
  const existingSlice = lines.slice(startIdx, startIdx + deleteCount);
  const existingText = toLineRangeString(existingSlice);

  if (op.expectedText !== undefined) {
    const expected = normalizeNewlines(op.expectedText);
    assert(existingText === expected, 'replace_line_range.expectedText mismatch');
  }
  if (op.expectedMd5 !== undefined) {
    const expectedHash = op.expectedMd5.toLowerCase();
    assert(md5(existingText) === expectedHash, 'replace_line_range.expectedMd5 mismatch');
  }

  const replacementLines = normalizeNewlines(op.replacement).split('\n');
  lines.splice(startIdx, deleteCount, ...replacementLines);
}

function applyInsertAtLine(
  lines: string[],
  op: Extract<KnowledgeEditOp, { type: 'insert_at_line' }>
): void {
  const line = op.line;
  const position = op.position ?? 'before';
  assert(Number.isInteger(line) && line >= 1, 'insert_at_line.line must be >= 1');
  assert(
    position === 'before' || position === 'after',
    'insert_at_line.position must be before or after'
  );

  let index: number;
  if (position === 'before') {
    assert(line <= lines.length + 1, 'insert_at_line before target out of range');
    index = Math.min(line - 1, lines.length);
    if (op.expectedNeighborText !== undefined && line <= lines.length) {
      assert(
        normalizeNewlines(op.expectedNeighborText) === lines[line - 1],
        'insert_at_line.expectedNeighborText mismatch'
      );
    }
  } else {
    assert(line <= lines.length, 'insert_at_line after target out of range');
    if (op.expectedNeighborText !== undefined) {
      assert(
        normalizeNewlines(op.expectedNeighborText) === lines[line - 1],
        'insert_at_line.expectedNeighborText mismatch'
      );
    }
    index = line;
  }

  const contentLines = normalizeNewlines(op.content).split('\n');
  lines.splice(index, 0, ...contentLines);
}

function applyDeleteLineRange(
  lines: string[],
  op: Extract<KnowledgeEditOp, { type: 'delete_line_range' }>
): void {
  const { startLine, endLine } = op;
  assert(Number.isInteger(startLine) && startLine >= 1, 'delete_line_range.startLine must be >= 1');
  assert(
    Number.isInteger(endLine) && endLine >= startLine,
    'delete_line_range.endLine must be >= startLine'
  );
  assert(endLine <= lines.length, 'delete_line_range range exceeds document length');

  const startIdx = startLine - 1;
  const deleteCount = endLine - startLine + 1;
  const existingSlice = lines.slice(startIdx, startIdx + deleteCount);
  const existingText = toLineRangeString(existingSlice);

  if (op.expectedText !== undefined) {
    const expected = normalizeNewlines(op.expectedText);
    assert(existingText === expected, 'delete_line_range.expectedText mismatch');
  }
  if (op.expectedMd5 !== undefined) {
    const expectedHash = op.expectedMd5.toLowerCase();
    assert(md5(existingText) === expectedHash, 'delete_line_range.expectedMd5 mismatch');
  }

  lines.splice(startIdx, deleteCount);
}

function applyReplaceLiteral(
  lines: string[],
  op: Extract<KnowledgeEditOp, { type: 'replace_literal' }>
): string[] {
  const haystack = joinLines(lines);
  const find = op.find;
  const replace = op.replace;
  assert(find.length > 0, 'replace_literal.find must be non-empty');
  const matches = countOccurrences(haystack, find);
  assert(matches === op.expectedCount, 'replace_literal.expectedCount mismatch');
  if (matches === 0) return lines;
  const updated = haystack.split(find).join(replace);
  return splitLines(updated);
}

export interface ApplyKnowledgeEditOpsResult {
  content: string;
}

export function applyKnowledgeEditOps(
  baseContent: string,
  ops: KnowledgeEditOp[]
): ApplyKnowledgeEditOpsResult {
  const normalizedBase = normalizeNewlines(baseContent);
  let lines = splitLines(normalizedBase);

  for (const op of ops) {
    switch (op.type) {
      case 'replace_line_range': {
        applyReplaceLineRange(lines, op);
        break;
      }
      case 'insert_at_line': {
        applyInsertAtLine(lines, op);
        break;
      }
      case 'delete_line_range': {
        applyDeleteLineRange(lines, op);
        break;
      }
      case 'replace_literal': {
        lines = applyReplaceLiteral(lines, op);
        break;
      }
      default: {
        const exhaustive: never = op;
        throw new KnowledgeEditError(
          `Unsupported KnowledgeEditOp: ${(exhaustive as { type: string }).type}`
        );
      }
    }
  }

  const content = joinLines(lines);
  return { content };
}

export { KnowledgeEditError };
