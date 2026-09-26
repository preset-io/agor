import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContentBlock, DiffEnrichment } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createGit } from '../../git/index.js';
import { attachGeneratedDiff, GENERATED_DIFF_BUDGET_BYTES } from '../../services/generated-diff.js';
import { enrichContentBlocks, enrichToolResults, registerToolUses } from './diff-enrichment.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('generated diff source budget', () => {
  it.each(['Write', 'Edit'])(
    'omits a long escaped/multibyte JSON line through the split %s route',
    (name) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'agor-diff-budget-'));
      dirs.push(dir);
      const file = path.join(dir, 'state.json');
      const text = JSON.stringify({ value: '\\"😀漢'.repeat(35_000) });
      writeFileSync(file, text);
      const input = { file_path: file, content: text, old_string: 'old', new_string: text };
      const before = structuredClone(input);
      registerToolUses([{ id: name, name, input }]);
      const result: ContentBlock = {
        type: 'tool_result',
        tool_use_id: name,
        content: { provider: 'exact result' },
        transcript_truncation: { provider_field: { original_bytes: 42 } },
      };
      enrichToolResults([result]);
      expect(result.diff).toBeUndefined();
      expect(result.transcript_truncation?.diff.original_bytes).toBeGreaterThan(
        GENERATED_DIFF_BUDGET_BYTES
      );
      expect(result.transcript_truncation?.provider_field).toEqual({ original_bytes: 42 });
      expect(result.content).toEqual({ provider: 'exact result' });
      expect(input).toEqual(before);
    }
  );

  it('counts edit_files structuredPatch/files duplication in one aggregate source limit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agor-diff-budget-'));
    dirs.push(dir);
    await createGit(dir).git.init();
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ value: 'x'.repeat(150_000) }));
    const input = { changes: [{ path: 'state.json', kind: 'add' }] };
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'edit', name: 'edit_files', input },
      { type: 'tool_result', tool_use_id: 'edit', content: 'ok' },
    ];
    enrichContentBlocks(blocks, { workingDirectory: dir });
    expect(blocks[1].diff).toBeUndefined();
    // Each copy alone would fit. Together the complete enrichment must be omitted.
    expect(blocks[1].transcript_truncation?.diff.original_bytes).toBeGreaterThan(300_000);
    expect(blocks[1].transcript_truncation?.diff.original_bytes).toBeLessThan(301_000);
    expect(blocks[0].input).toEqual(input);
    expect(blocks[1].content).toBe('ok');
  });

  it('measures escaped UTF-8 plus wrapper exactly and omits whole hunks at cap + 1', () => {
    const diff: DiffEnrichment = {
      structuredPatch: [
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+\\"😀漢'] },
      ],
    };
    diff.structuredPatch[0].lines[0] += 'x'.repeat(GENERATED_DIFF_BUDGET_BYTES - bytes({ diff }));
    const result: ContentBlock = { type: 'tool_result', content: 'ok' };
    attachGeneratedDiff(result, diff);
    expect(bytes({ diff: result.diff })).toBe(GENERATED_DIFF_BUDGET_BYTES);
    expect(result.diff).toBe(diff);
    expect(result.transcript_truncation).toBeUndefined();
    const oversized = structuredClone(diff);
    oversized.structuredPatch[0].lines[0] += 'x';
    const omitted: ContentBlock = { type: 'tool_result', content: 'ok' };
    attachGeneratedDiff(omitted, oversized);
    expect(omitted.diff).toBeUndefined();
    expect(omitted.transcript_truncation).toEqual({ diff: { original_bytes: bytes(oversized) } });
  });
});
