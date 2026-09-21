import type { ContentBlock, DiffEnrichment, MessagePatch } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { attachGeneratedDiff } from './generated-diff.js';
import { projectMessageData, projectTranscriptData } from './tool-result-truncator.js';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function diffOfSize(size: number): DiffEnrichment {
  const diff = {
    structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+'] }],
  };
  diff.structuredPatch[0].lines[0] += 'd'.repeat(size - bytes(diff));
  return diff;
}

describe('transcript retention priority', () => {
  it.each(['input', 'result'] as const)(
    'preserves the original %s in the 850172-byte reproduction',
    (field) => {
      const call: ContentBlock = { type: 'tool_use', id: 't', name: 'Write', input: {} };
      const result: ContentBlock = { type: 'tool_result', tool_use_id: 't', content: '' };
      const data = { content: [call, result] };
      if (field === 'input') call.input = { content: '' };
      const original = 'x'.repeat(600_142 - bytes(data));
      if (field === 'input') call.input = { content: original };
      else result.content = original;
      expect(bytes(data)).toBe(600_142);
      attachGeneratedDiff(result, diffOfSize(250_022));
      expect(bytes(data)).toBe(850_172);
      const snapshot = structuredClone(data);
      const projected = projectMessageData(data, 800_000);
      expect(bytes(projected)).toBeLessThanOrEqual(800_000);
      expect(projected.content[0]).toEqual(call);
      expect(projected.content[1]).toEqual({
        type: 'tool_result',
        tool_use_id: 't',
        content: result.content,
        transcript_truncation: { diff: { original_bytes: 250_022 } },
      });
      expect(data).toEqual(snapshot);
    }
  );

  it('exhausts duplicated enrichment before duplicated inputs and provider-original fields', () => {
    const input = { patch: 'i'.repeat(290_000) };
    const call: ContentBlock = { type: 'tool_use', id: 't', name: 'Write', input };
    const result: ContentBlock = {
      type: 'tool_result',
      tool_use_id: 't',
      content: { exact: '\\"😀漢' },
      provider_data: { text: 'p'.repeat(20_000) },
    };
    attachGeneratedDiff(result, diffOfSize(150_000));
    const duplicate = { ...result };
    const data = {
      content: [call, result, duplicate],
      tool_uses: [{ id: 't', name: 'Write', input }],
      content_preview: '\\"😀漢'.repeat(100),
    };
    const original = structuredClone(data);
    // Requires both diff copies to go; originals including both inputs fit.
    const projected = projectMessageData(data, 650_000);
    expect(bytes(projected)).toBeLessThanOrEqual(650_000);
    expect(projected.content[0]).toEqual(call);
    expect(projected.tool_uses).toEqual(data.tool_uses);
    for (const block of projected.content.slice(1)) {
      expect(block.diff).toBeUndefined();
      expect(block.content).toEqual(result.content);
      expect(block.provider_data).toEqual(result.provider_data);
      expect(Object.keys(block.transcript_truncation ?? {})).toEqual(['diff']);
    }
    expect(projected.content_preview).toBe(data.content_preview);
    expect(data).toEqual(original);
  });

  it('removes generated data in a smaller bulk entry before originals in a larger one', () => {
    const original: MessagePatch = {
      content: [{ type: 'tool_result', content: 'x'.repeat(600_000) }],
    };
    const result: ContentBlock = { type: 'tool_result', content: 'ok' };
    attachGeneratedDiff(result, diffOfSize(250_000));
    const data = [original, { content: [result] }];
    const projected = projectTranscriptData(data, 800_000) as MessagePatch[];
    expect(bytes(projected)).toBeLessThanOrEqual(800_000);
    expect(projected[0]).toEqual(original);
    expect(projected[1].content).toEqual([
      {
        type: 'tool_result',
        content: 'ok',
        transcript_truncation: { diff: { original_bytes: 250_000 } },
      },
    ]);
  });

  it('keeps escaped/multibyte originals exact at the wrapper-and-notice budget edge', () => {
    const input = { value: '\\"\n\t😀漢'.repeat(3_000) };
    const content = JSON.stringify({ result: '\\"\n\t😀漢'.repeat(3_000) });
    const result: ContentBlock = { type: 'tool_result', tool_use_id: 't', content };
    attachGeneratedDiff(result, diffOfSize(10_000));
    const data = {
      content: [{ type: 'tool_use' as const, id: 't', name: 'Write', input }, result],
      content_preview: '\\"😀漢'.repeat(200),
    };
    const expected = {
      ...data,
      content: [
        data.content[0],
        {
          type: 'tool_result',
          tool_use_id: 't',
          content,
          transcript_truncation: { diff: { original_bytes: 10_000 } },
        },
      ],
    };
    const projected = projectMessageData(data, bytes(expected));
    expect(projected).toEqual(expected);
    expect(bytes(projected)).toBe(bytes(expected));
    expect(JSON.parse(projected.content[1].content as string)).toEqual(JSON.parse(content));
    expect(input.value).not.toContain('\uFFFD');
  });

  it('does not treat arbitrary provider data or a provider diff as generated', () => {
    const providerDiff = diffOfSize(250_000);
    const result: ContentBlock = {
      type: 'tool_result',
      content: 'x'.repeat(610_000),
      diff: providerDiff,
    };
    // Also prove the enrichment source never overwrites an existing provider field.
    attachGeneratedDiff(result, diffOfSize(100));
    expect(result.diff).toBe(providerDiff);
    const projected = projectMessageData({ content: [result] }, 800_000);
    expect(projected.content[0].diff).toEqual(providerDiff);
    expect(projected.content[0].transcript_truncation?.content).toBeDefined();
    expect(result.content).toBe('x'.repeat(610_000));
  });

  it('keeps outer JSON valid but does not promise parseable shortened JSON result text', () => {
    const original = JSON.stringify({ value: 'x'.repeat(900_000) });
    const data = { content: [{ type: 'tool_result' as const, content: original }] };
    const saved = JSON.parse(JSON.stringify(projectMessageData(data, 800_000)));
    expect(bytes(saved)).toBeLessThanOrEqual(800_000);
    expect(saved.content[0].transcript_truncation.content.original_bytes).toBe(bytes(original));
    expect(() => JSON.parse(saved.content[0].content)).toThrow();
    expect(data.content[0].content).toBe(original);
  });
});
