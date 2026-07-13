import { describe, expect, it } from 'vitest';
import {
  EXECUTOR_REQUEST_DATA_BUDGET_BYTES,
  projectTranscriptRequestData,
} from './transcript-projector.js';

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

describe('projectTranscriptRequestData', () => {
  it('passes request data at the byte budget through by identity', () => {
    const data = {
      content: 'x'.repeat(EXECUTOR_REQUEST_DATA_BUDGET_BYTES - 14),
    };
    expect(serializedBytes(data)).toBe(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);

    expect(projectTranscriptRequestData(data, { path: 'messages', method: 'create' })).toBe(data);
  });

  it('immutably projects an oversized Unicode result while preserving its outer semantics', () => {
    const content = `BEGIN🙂e\u0301漢字${'middle'.repeat(150_000)}TAIL🚀नमस्ते`;
    const originalResult = {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content,
      is_error: true,
      metadata: { provider: 'test', nested: { untouched: true } },
      diff: {
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
        ],
        files: [
          {
            path: 'src/file.ts',
            kind: 'update' as const,
            structuredPatch: [
              { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] },
            ],
          },
        ],
      },
      provider_extension: { value: 42 },
    };
    const data = {
      message_id: 'message-1',
      content: [{ type: 'text', text: 'unchanged' }, originalResult],
    };
    const before = JSON.stringify(data);
    Object.freeze(originalResult.metadata.nested);
    Object.freeze(originalResult.metadata);
    Object.freeze(originalResult.diff.structuredPatch[0]);
    Object.freeze(originalResult.diff.structuredPatch);
    Object.freeze(originalResult.diff.files[0].structuredPatch[0]);
    Object.freeze(originalResult.diff.files[0].structuredPatch);
    Object.freeze(originalResult.diff.files[0]);
    Object.freeze(originalResult.diff.files);
    Object.freeze(originalResult.diff);
    Object.freeze(originalResult.provider_extension);
    Object.freeze(originalResult);
    Object.freeze(data.content);
    Object.freeze(data);

    const projected = projectTranscriptRequestData(data, {
      path: 'messages',
      method: 'create',
    }) as typeof data;
    const result = projected.content[1];

    expect(projected).not.toBe(data);
    expect(serializedBytes(projected)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
    expect(result.content).toContain('BEGIN🙂é漢字');
    expect(result.content).toContain('TAIL🚀नमस्ते');
    expect(result.content).toContain('Middle omitted from transcript storage');
    expect(result.content).not.toContain('�');
    expect(result).toMatchObject({
      tool_use_id: 'tool-1',
      is_error: true,
      metadata: { provider: 'test', nested: { untouched: true } },
      diff: originalResult.diff,
      provider_extension: { value: 42 },
      transcript_projection: {
        truncated: true,
        original_content_bytes: Buffer.byteLength(content, 'utf8'),
        persisted_content_bytes: Buffer.byteLength(result.content, 'utf8'),
      },
    });
    expect(JSON.stringify(data)).toBe(before);
  });

  it('projects structured result content into a bounded textual preview with exact byte metadata', () => {
    const content = [
      { type: 'text', text: `STRUCTURED_HEAD_${'x'.repeat(450_000)}` },
      { type: 'text', text: `${'y'.repeat(450_000)}_STRUCTURED_TAIL` },
    ];
    const data = {
      content: [{ type: 'tool_result', tool_use_id: 'tool-structured', content }],
    };
    const before = JSON.stringify(data);
    Object.freeze(content[0]);
    Object.freeze(content[1]);
    Object.freeze(content);
    Object.freeze(data.content[0]);
    Object.freeze(data.content);
    Object.freeze(data);

    const projected = projectTranscriptRequestData(data, {
      path: 'messages',
      method: 'patch',
    }) as {
      content: Array<{
        content: string;
        transcript_projection: {
          truncated: true;
          original_content_bytes: number;
          persisted_content_bytes: number;
        };
      }>;
    };
    const result = projected.content[0];

    expect(typeof result.content).toBe('string');
    expect(result.content).toContain('STRUCTURED_HEAD');
    expect(result.content).toContain('STRUCTURED_TAIL');
    expect(result.content).toContain('Middle omitted from transcript storage');
    expect(result.transcript_projection).toEqual({
      truncated: true,
      original_content_bytes: Buffer.byteLength(JSON.stringify(content), 'utf8'),
      persisted_content_bytes: Buffer.byteLength(result.content, 'utf8'),
    });
    expect(serializedBytes(projected)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('reduces the largest result first and uses encounter order to break equal-size ties', () => {
    const first = {
      type: 'tool_result',
      tool_use_id: 'first',
      content: `FIRST_HEAD_${'a'.repeat(449_980)}_FIRST_TAIL`,
    };
    const second = {
      type: 'tool_result',
      tool_use_id: 'second',
      content: `SECOND_HEAD_${'b'.repeat(449_978)}_SECOND_TAIL`,
    };
    expect(Buffer.byteLength(first.content)).toBe(Buffer.byteLength(second.content));
    const data = { content: [first, second] };

    const projected = projectTranscriptRequestData(data, {
      path: 'messages',
      method: 'create',
    }) as {
      content: Array<Record<string, unknown>>;
    };

    expect(projected.content[0]).toHaveProperty('transcript_projection');
    expect(projected.content[1]).toBe(second);
    expect(serializedBytes(projected)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
  });

  it('orders candidates across bulk messages and remains deterministic across concurrent calls', async () => {
    const smaller = {
      type: 'tool_result',
      tool_use_id: 'smaller',
      content: `SMALLER_${'s'.repeat(349_980)}_TAIL`,
    };
    const larger = {
      type: 'tool_result',
      tool_use_id: 'larger',
      content: `LARGER_${'l'.repeat(499_980)}_TAIL`,
    };
    const data = [
      { message_id: 'one', content: [smaller] },
      { message_id: 'two', content: [larger] },
    ];

    const [left, right] = await Promise.all([
      Promise.resolve(
        projectTranscriptRequestData(data, { path: 'messages/bulk', method: 'create' })
      ),
      Promise.resolve(
        projectTranscriptRequestData(data, { path: 'messages/bulk', method: 'create' })
      ),
    ]);
    const projected = left as Array<{ content: Array<Record<string, unknown>> }>;

    expect(left).toEqual(right);
    expect(projected[0].content[0]).toBe(smaller);
    expect(projected[1].content[0]).toHaveProperty('transcript_projection');
    expect(serializedBytes(left)).toBeLessThanOrEqual(EXECUTOR_REQUEST_DATA_BUDGET_BYTES);
  });

  it('rejects irreducible non-result data with a bounded content-free diagnostic', () => {
    const secret = `DO_NOT_ECHO_${'z'.repeat(EXECUTOR_REQUEST_DATA_BUDGET_BYTES)}`;

    expect(() =>
      projectTranscriptRequestData(
        {
          preserved_non_result: secret,
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'small',
              content: 'small result',
              diff: { structuredPatch: [], huge_preserved_diff: 'd'.repeat(1000) },
            },
          ],
        },
        { path: 'messages', method: 'patch' }
      )
    ).toThrowError(
      new RegExp(
        `Transcript request data is \\d+ bytes, exceeding the ${EXECUTOR_REQUEST_DATA_BUDGET_BYTES}-byte budget \\(messages\\.patch\\)`
      )
    );

    try {
      projectTranscriptRequestData(
        { preserved_non_result: secret },
        { path: 'messages', method: 'patch' }
      );
    } catch (error) {
      expect(String(error)).not.toContain('DO_NOT_ECHO');
      expect(String(error).length).toBeLessThan(200);
    }
  });

  it('rejects serialization failure without echoing result content', () => {
    const cyclic: Record<string, unknown> = { secret: 'SERIALIZATION_SECRET' };
    cyclic.self = cyclic;

    expect(() =>
      projectTranscriptRequestData(cyclic, { path: 'messages/bulk', method: 'create' })
    ).toThrowError(
      `Transcript request data could not be serialized (size unavailable; budget ${EXECUTOR_REQUEST_DATA_BUDGET_BYTES} bytes; messages/bulk.create)`
    );
    try {
      projectTranscriptRequestData(cyclic, { path: 'messages/bulk', method: 'create' });
    } catch (error) {
      expect(String(error)).not.toContain('SERIALIZATION_SECRET');
    }
  });
});
