import type { ContentBlock, MessagePatch } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { projectMessageData } from './tool-result-truncator.js';

const BUDGET = 2_000;
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

function toolMessage(content: unknown): MessagePatch & { content: ContentBlock[] } {
  return {
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content, is_error: true },
    ],
    content_preview: 'preview',
  };
}

describe('projectMessageData', () => {
  it('passes through small messages unchanged', () => {
    const data = toolMessage('small');
    expect(projectMessageData(data, BUDGET)).toBe(data);
  });

  it.each([
    'x'.repeat(4_000),
    Array.from({ length: 500 }, (_, id) => ({ id, text: 'synthetic output' })),
    { large_field: 'z'.repeat(4_000), small_a: 'kept-a', small_b: 'kept-b' },
    '\\"\n\t😀漢'.repeat(4_000),
    [{ enormousFirstItem: 'x'.repeat(8_000) }],
  ])('bounds serialized result payloads with explicit size metadata', (content) => {
    const data = toolMessage(content);
    const snapshot = structuredClone(data);
    const projected = projectMessageData(data, BUDGET);
    expect(byteSize(projected)).toBeLessThanOrEqual(BUDGET);
    expect(projected.content[1]).toMatchObject({
      tool_use_id: 't1',
      is_error: true,
      transcript_truncation: { content: { original_bytes: byteSize(content) } },
    });
    expect(JSON.stringify(projected.content[1].content)).toMatch(/truncated|omitted/);
    expect(data).toEqual(snapshot);
    expect(projected.content[0]).toEqual(data.content[0]);
  });

  it('does not split multibyte code points in retained output', () => {
    const projected = projectMessageData(toolMessage('😀漢'.repeat(1_000)), BUDGET);
    expect(projected.content[1].content).toContain('truncated');
    expect(projected.content[1].content).not.toContain('\uFFFD');
    expect(byteSize(projected)).toBeLessThanOrEqual(BUDGET);
  });

  it('retains existing structured result and line-output projections', () => {
    const array = projectMessageData(
      toolMessage(Array.from({ length: 500 }, (_, id) => ({ id }))),
      BUDGET
    );
    expect(Array.isArray(array.content[1].content)).toBe(true);
    const obj = projectMessageData(
      toolMessage({ large: 'x'.repeat(4_000), small: 'kept' }),
      BUDGET
    );
    expect(obj.content[1].content).toHaveProperty('small');
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}: ${'data'.repeat(20)}`).join(
      '\n'
    );
    const projected = projectMessageData(toolMessage(lines), 14_000);
    expect(projected.content[1].content).toContain('lines omitted');
  });

  it('omits duplicate input projections together without changing execution arguments', () => {
    const input = {
      patch: `*** Begin Patch\n*** Add File: state.json\n+${'x'.repeat(8_000)}\n*** End Patch`,
    };
    const data = toolMessage('ok');
    data.content[0].input = input;
    data.content[0].status = 'completed';
    data.tool_uses = [{ id: 't1', name: 'Bash', input }];
    const projected = projectMessageData(data, BUDGET);
    expect(byteSize(projected)).toBeLessThanOrEqual(BUDGET);
    expect(projected.content[0]).toMatchObject({
      id: 't1',
      name: 'Bash',
      status: 'completed',
      transcript_truncation: { input: { original_bytes: byteSize(input) } },
    });
    expect(projected.content[0].input).toEqual(projected.tool_uses?.[0].input);
    expect(projected.tool_uses?.[0].input).not.toHaveProperty('patch');
    expect(projected.content[1]).toEqual(data.content[1]);
    expect(input.patch).toContain('x'.repeat(8_000));
    expect(data.tool_uses[0].input).toBe(input);
  });

  it('omits diff enrichment as a unit while preserving results and status', () => {
    const data = toolMessage('ok');
    data.content[1].diff = { structuredPatch: [{ lines: [`+${'x'.repeat(8_000)}`] }] };
    const projected = projectMessageData(data, BUDGET);
    expect(byteSize(projected)).toBeLessThanOrEqual(BUDGET);
    expect(projected.content[1]).not.toHaveProperty('diff');
    expect(projected.content[1]).toMatchObject({
      content: 'ok',
      is_error: true,
      transcript_truncation: { diff: { original_bytes: byteSize(data.content[1].diff) } },
    });
    expect(data.content[1]).toHaveProperty('diff');
  });

  it('accounts for wrapper overhead even when content alone fits', () => {
    const data = toolMessage('x'.repeat(1_500));
    const contentSize = byteSize(data.content);
    data.content_preview = '😀"\\'.repeat(100);
    expect(byteSize(data)).toBeGreaterThan(contentSize);
    const projected = projectMessageData(data, contentSize);
    expect(byteSize(projected)).toBeLessThanOrEqual(contentSize);
    expect(projected.content_preview).toBe(data.content_preview);
  });

  it('reduces the largest payload first, including multiple independent tools', () => {
    const data = toolMessage('small');
    data.content.push({ type: 'tool_result', tool_use_id: 't2', content: 'x'.repeat(4_000) });
    const projected = projectMessageData(data, BUDGET);
    expect(projected.content[1]).toEqual(data.content[1]);
    expect(projected.content[2].transcript_truncation).toBeDefined();
    expect(byteSize(projected)).toBeLessThanOrEqual(BUDGET);
  });

  it('does not inflate small duplicate inputs with omission metadata', () => {
    const data = toolMessage('ok');
    const input = { patch: 'x'.repeat(40) };
    data.content[0].input = input;
    data.tool_uses = [{ id: 't1', name: 'Bash', input }];
    expect(projectMessageData(data, 1)).toEqual(data);
  });

  it('does not discard identity, authority or non-tool content to force a fit', () => {
    const data = {
      ...toolMessage('ok'),
      metadata: { tenant_id: 'tenant-a', diagnostic: 'x'.repeat(4_000) },
    };
    expect(projectMessageData(data, BUDGET)).toEqual(data);
    const text = { content: 'x'.repeat(4_000) };
    expect(projectMessageData(text, BUDGET)).toEqual(text);
  });
});
