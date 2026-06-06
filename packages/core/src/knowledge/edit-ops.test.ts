import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KnowledgeEditOp } from '../types/knowledge.js';
import { applyKnowledgeEditOps, KnowledgeEditError } from './edit-ops.js';

describe('applyKnowledgeEditOps', () => {
  it('replaces a line range', () => {
    const base = '# Title\nLine A\nLine B';
    const ops: KnowledgeEditOp[] = [
      {
        type: 'replace_line_range',
        startLine: 2,
        endLine: 3,
        replacement: 'Line B\nLine C',
        expectedText: 'Line A\nLine B',
      },
    ];
    const result = applyKnowledgeEditOps(base, ops);
    expect(result.content).toBe('# Title\nLine B\nLine C');
  });

  it('inserts before and after lines', () => {
    const base = 'alpha\nbeta';
    const ops: KnowledgeEditOp[] = [
      {
        type: 'insert_at_line',
        line: 1,
        position: 'before',
        content: 'intro',
      },
      {
        type: 'insert_at_line',
        line: 3,
        position: 'after',
        content: 'omega',
      },
    ];
    const result = applyKnowledgeEditOps(base, ops);
    expect(result.content).toBe('intro\nalpha\nbeta\nomega');
  });

  it('deletes lines with expected md5', () => {
    const base = 'keep\nremove\nme';
    const ops: KnowledgeEditOp[] = [
      {
        type: 'delete_line_range',
        startLine: 2,
        endLine: 3,
        expectedMd5: createHash('md5').update('remove\nme').digest('hex'),
      },
    ];
    const result = applyKnowledgeEditOps(base, ops);
    expect(result.content).toBe('keep');
  });

  it('replaces literal occurrences with expected count', () => {
    const base = 'foo bar foo';
    const ops: KnowledgeEditOp[] = [
      {
        type: 'replace_literal',
        find: 'foo',
        replace: 'baz',
        expectedCount: 2,
      },
    ];
    const result = applyKnowledgeEditOps(base, ops);
    expect(result.content).toBe('baz bar baz');
  });

  it('throws when expected literal count mismatches', () => {
    const base = 'foo';
    const ops: KnowledgeEditOp[] = [
      { type: 'replace_literal', find: 'foo', replace: 'baz', expectedCount: 2 },
    ];
    expect(() => applyKnowledgeEditOps(base, ops)).toThrow(KnowledgeEditError);
  });

  it('applies sequential mixed operations', () => {
    const base = 'Line 1\nLine 2\nLine 3';
    const ops: KnowledgeEditOp[] = [
      {
        type: 'replace_line_range',
        startLine: 2,
        endLine: 2,
        replacement: 'Middle',
      },
      {
        type: 'insert_at_line',
        line: 3,
        position: 'before',
        content: 'Inserted',
      },
      {
        type: 'replace_literal',
        find: 'Line',
        replace: 'Row',
        expectedCount: 2,
      },
    ];
    const result = applyKnowledgeEditOps(base, ops);
    expect(result.content).toBe('Row 1\nMiddle\nInserted\nRow 3');
  });
});
