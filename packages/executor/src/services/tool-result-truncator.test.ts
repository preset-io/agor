import { describe, expect, it } from 'vitest';
import {
  type ContentBlock,
  type ToolUseRef,
  truncateContentIfNeeded,
} from './tool-result-truncator.js';

function byteSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

function makeToolUseBlock(id: string, name: string): ContentBlock {
  return { type: 'tool_use', id, name, input: {} };
}

function makeToolResultBlock(id: string, content: unknown): ContentBlock {
  return { type: 'tool_result', tool_use_id: id, content };
}

describe('truncateContentIfNeeded', () => {
  const BUDGET = 2_000;

  it('passes through content under budget', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', 'small output'),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncated).toBe(false);
    expect(result.blocks).toEqual(blocks);
    expect(result.truncatedTools).toEqual([]);
  });

  it('truncates oversized tool result string content', () => {
    const bigOutput = 'x'.repeat(BUDGET * 2);
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', bigOutput),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncated).toBe(true);
    expect(byteSize(result.blocks)).toBeLessThanOrEqual(BUDGET);
    expect(result.truncatedTools).toContain('Bash');
    const resultContent = result.blocks[1].content as string;
    expect(resultContent).toContain('truncated');
  });

  it('truncates oversized JSON array content', () => {
    const bigArray = Array.from({ length: 500 }, (_, i) => ({
      id: `item-${i}`,
      name: `Item ${i} with some extra padding to make it larger`,
    }));
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'agor_branches_list'),
      makeToolResultBlock('t1', bigArray),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncated).toBe(true);
    expect(byteSize(result.blocks)).toBeLessThanOrEqual(BUDGET);
    const resultContent = result.blocks[1].content as unknown[];
    expect(Array.isArray(resultContent)).toBe(true);
    expect(resultContent.length).toBeLessThan(bigArray.length);
    const lastItem = resultContent[resultContent.length - 1];
    expect(typeof lastItem === 'string' && lastItem.includes('truncated')).toBe(true);
  });

  it('resolves tool name from inline tool_use block', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Read'),
      makeToolResultBlock('t1', 'x'.repeat(BUDGET * 2)),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncatedTools).toContain('Read');
  });

  it('resolves tool name from toolUses array', () => {
    const toolUses: ToolUseRef[] = [{ id: 't1', name: 'Grep', input: {} }];
    const blocks: ContentBlock[] = [makeToolResultBlock('t1', 'x'.repeat(BUDGET * 2))];
    const result = truncateContentIfNeeded(blocks, toolUses, BUDGET);
    expect(result.truncatedTools).toContain('Grep');
  });

  it('truncates the largest tool result first', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', 'small'),
      makeToolUseBlock('t2', 'Read'),
      makeToolResultBlock('t2', 'y'.repeat(BUDGET * 3)),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncated).toBe(true);
    expect(result.blocks[1].content).toBe('small');
    expect(result.blocks[3].content).not.toBe('y'.repeat(BUDGET * 3));
  });

  it('falls back to omission when truncation cannot meet budget', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', 'x'.repeat(BUDGET * 10)),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, 300);
    expect(result.truncated).toBe(true);
    const content = result.blocks[1].content as string;
    expect(content).toContain('omitted');
  });

  it('handles line-based Bash output truncation', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'data'.repeat(20)}`);
    const bigOutput = lines.join('\n');
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', bigOutput),
    ];
    // Use a budget large enough that line-based head+tail fits
    const result = truncateContentIfNeeded(blocks, undefined, 14_000);
    expect(result.truncated).toBe(true);
    const content = result.blocks[1].content as string;
    expect(content).toContain('lines omitted');
  });

  it('does not modify non-tool-result blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello world' },
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', 'x'.repeat(BUDGET * 2)),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.blocks[0]).toEqual({ type: 'text', text: 'Hello world' });
  });

  it('handles object content with large values', () => {
    const bigObj = {
      summary: 'small',
      data: 'z'.repeat(BUDGET * 2),
      metadata: { key: 'value' },
    };
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'custom_tool'),
      makeToolResultBlock('t1', bigObj),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncated).toBe(true);
    expect(byteSize(result.blocks)).toBeLessThanOrEqual(BUDGET);
  });

  it('preserves all sibling fields in truncated objects', () => {
    const bigObj = {
      large_field: 'z'.repeat(BUDGET * 2),
      small_a: 'kept-a',
      small_b: 'kept-b',
    };
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'custom_tool'),
      makeToolResultBlock('t1', bigObj),
    ];
    const result = truncateContentIfNeeded(blocks, undefined, BUDGET);
    expect(result.truncated).toBe(true);
    const obj = result.blocks[1].content as Record<string, unknown>;
    expect(obj).toHaveProperty('large_field');
    expect(obj).toHaveProperty('small_a');
    expect(obj).toHaveProperty('small_b');
    expect(typeof obj.large_field === 'string' && obj.large_field.includes('truncated')).toBe(true);
  });

  it('uses default budget from EXECUTOR_REQUEST_DATA_BUDGET_BYTES', () => {
    const blocks: ContentBlock[] = [
      makeToolUseBlock('t1', 'Bash'),
      makeToolResultBlock('t1', 'small output'),
    ];
    const result = truncateContentIfNeeded(blocks, undefined);
    expect(result.truncated).toBe(false);
  });
});
