import { describe, expect, it } from 'vitest';
import { createOpenCodeEventTranslator, reconcileOpenCodeMessages } from './event-translator.js';

describe('OpenCode event translator', () => {
  it('emits real assistant text deltas for the active session', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(),
    });

    translator.translate({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
      },
    });
    translator.translate({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          sessionID: 'session-active',
          messageID: 'assistant-1',
          type: 'text',
          text: '',
        },
      },
    });

    expect(
      translator.translate({
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-active',
          messageID: 'assistant-1',
          partID: 'part-1',
          field: 'text',
          delta: 'Hello',
        },
      })
    ).toEqual([{ type: 'text-delta', delta: 'Hello' }]);
  });

  it('filters foreign, user, and baseline messages while supporting multiple assistant IDs', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(['assistant-before-turn']),
    });
    for (const [id, sessionID, role] of [
      ['assistant-before-turn', 'session-active', 'assistant'],
      ['user-current', 'session-active', 'user'],
      ['assistant-foreign', 'session-foreign', 'assistant'],
      ['assistant-1', 'session-active', 'assistant'],
      ['assistant-2', 'session-active', 'assistant'],
    ]) {
      translator.translate({
        type: 'message.updated',
        properties: { info: { id, sessionID, role } },
      });
      translator.translate({
        type: 'message.part.updated',
        properties: {
          part: { id: `part-${id}`, sessionID, messageID: id, type: 'text', text: '' },
        },
      });
    }

    const effects = [
      ['assistant-before-turn', 'old'],
      ['user-current', 'user'],
      ['assistant-foreign', 'foreign'],
      ['assistant-1', 'before tool'],
      ['assistant-2', 'after tool'],
    ].flatMap(([messageID, delta]) =>
      translator.translate({
        type: 'message.part.delta',
        properties: {
          sessionID: messageID === 'assistant-foreign' ? 'session-foreign' : 'session-active',
          messageID,
          partID: `part-${messageID}`,
          field: 'text',
          delta,
        },
      })
    );

    expect(effects).toEqual([
      { type: 'text-delta', delta: 'before tool' },
      { type: 'text-delta', delta: 'after tool' },
    ]);
  });

  it('buffers deltas until message and part snapshots identify assistant reasoning', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(),
    });

    expect(
      translator.translate({
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-active',
          messageID: 'assistant-1',
          partID: 'reasoning-1',
          field: 'text',
          delta: 'private thought',
        },
      })
    ).toEqual([]);
    expect(
      translator.translate({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'reasoning-1',
            sessionID: 'session-active',
            messageID: 'assistant-1',
            type: 'reasoning',
            text: 'private thought',
          },
        },
      })
    ).toEqual([]);
    expect(
      translator.translate({
        type: 'message.updated',
        properties: {
          info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
        },
      })
    ).toEqual([{ type: 'reasoning-delta', delta: 'private thought' }]);
  });

  it('preserves arrival order while an earlier delta awaits correlation', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(),
    });
    translator.translate({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-active',
        messageID: 'assistant-1',
        partID: 'part-1',
        field: 'text',
        delta: 'first',
      },
    });
    translator.translate({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-2', sessionID: 'session-active', role: 'assistant' },
      },
    });
    translator.translate({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-2',
          sessionID: 'session-active',
          messageID: 'assistant-2',
          type: 'text',
        },
      },
    });

    expect(
      translator.translate({
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-active',
          messageID: 'assistant-2',
          partID: 'part-2',
          field: 'text',
          delta: 'second',
        },
      })
    ).toEqual([]);
    translator.translate({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          sessionID: 'session-active',
          messageID: 'assistant-1',
          type: 'text',
        },
      },
    });
    expect(
      translator.translate({
        type: 'message.updated',
        properties: {
          info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
        },
      })
    ).toEqual([
      { type: 'text-delta', delta: 'first' },
      { type: 'text-delta', delta: 'second' },
    ]);
  });

  it('evicts the oldest unmatched delta at the bounded queue cap', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(),
    });
    translator.translate({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-active',
        messageID: 'unmatched',
        partID: 'unmatched-part',
        field: 'text',
        delta: 'evicted',
      },
    });
    translator.translate({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
      },
    });
    translator.translate({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          sessionID: 'session-active',
          messageID: 'assistant-1',
          type: 'text',
        },
      },
    });

    const effects = Array.from({ length: 256 }, (_, index) =>
      translator.translate({
        type: 'message.part.delta',
        properties: {
          sessionID: 'session-active',
          messageID: 'assistant-1',
          partID: 'part-1',
          field: 'text',
          delta: `delta-${index}`,
        },
      })
    ).flat();

    expect(effects).toHaveLength(256);
    expect(effects[0]).toEqual({ type: 'text-delta', delta: 'delta-0' });
    expect(effects.at(-1)).toEqual({ type: 'text-delta', delta: 'delta-255' });
  });

  it('normalizes tool snapshots once per state transition', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(),
    });
    translator.translate({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
      },
    });
    const snapshot = (status: string) =>
      translator.translate({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool-part-1',
            sessionID: 'session-active',
            messageID: 'assistant-1',
            type: 'tool',
            tool: 'bash',
            callID: 'call-1',
            state: { status, input: { command: 'pwd' } },
          },
        },
      });

    expect(snapshot('pending')).toEqual([
      { type: 'tool-activity', tool: 'bash', status: 'pending' },
    ]);
    expect(snapshot('pending')).toEqual([]);
    expect(snapshot('running')).toEqual([
      { type: 'tool-activity', tool: 'bash', status: 'running' },
    ]);
    expect(snapshot('completed')).toEqual([
      { type: 'tool-activity', tool: 'bash', status: 'completed' },
    ]);
  });

  it('normalizes current and legacy permission shapes without deciding them', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(),
    });

    expect(
      translator.translate({
        type: 'permission.asked',
        properties: {
          id: 'permission-current',
          sessionID: 'session-active',
          permission: 'external_directory',
          patterns: ['/tmp/*'],
          metadata: { source: 'tool' },
        },
      })
    ).toEqual([
      {
        type: 'permission',
        request: {
          id: 'permission-current',
          permission: 'external_directory',
          patterns: ['/tmp/*'],
          metadata: { source: 'tool' },
        },
      },
    ]);
    expect(
      translator.translate({
        type: 'permission.updated',
        properties: {
          id: 'permission-legacy',
          sessionID: 'session-active',
          type: 'bash',
          pattern: 'git status',
          metadata: {},
        },
      })
    ).toEqual([
      {
        type: 'permission',
        request: {
          id: 'permission-legacy',
          permission: 'bash',
          patterns: ['git status'],
          metadata: {},
        },
      },
    ]);
  });

  it('accepts terminal evidence only after active-turn assistant activity', () => {
    const translator = createOpenCodeEventTranslator({
      sessionId: 'session-active',
      baselineMessageIds: new Set(['assistant-before-turn']),
    });
    const idle = {
      type: 'session.status',
      properties: { sessionID: 'session-active', status: { type: 'idle' } },
    };

    expect(translator.translate(idle)).toEqual([]);
    translator.translate({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-before-turn', sessionID: 'session-active', role: 'assistant' },
      },
    });
    expect(translator.translate(idle)).toEqual([]);
    translator.translate({
      type: 'message.updated',
      properties: {
        info: { id: 'assistant-current', sessionID: 'session-active', role: 'assistant' },
      },
    });
    expect(translator.translate(idle)).toEqual([{ type: 'idle' }]);
    expect(
      translator.translate({
        type: 'session.error',
        properties: {
          sessionID: 'session-active',
          error: { name: 'APIError', data: { message: 'provider failed' } },
        },
      })
    ).toEqual([{ type: 'error', message: 'provider failed' }]);
  });
});

describe('OpenCode transcript reconciliation', () => {
  it('excludes the baseline and preserves deduplicated text-tool-text order', () => {
    const messages = [
      {
        info: { id: 'baseline', sessionID: 'session-active', role: 'assistant' },
        parts: [{ id: 'old-text', type: 'text', text: 'old answer' }],
      },
      {
        info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
        parts: [
          { id: 'text-1', type: 'text', text: 'before tool' },
          {
            id: 'tool-1-pending',
            type: 'tool',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'pending', input: { command: 'pwd' } },
          },
        ],
      },
      {
        info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
        parts: [
          { id: 'text-1', type: 'text', text: 'before tool' },
          {
            id: 'tool-1-completed',
            type: 'tool',
            callID: 'call-1',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'pwd' }, output: '/worktree' },
          },
        ],
      },
      {
        info: { id: 'assistant-2', sessionID: 'session-active', role: 'assistant' },
        parts: [
          { id: 'reasoning-1', type: 'reasoning', text: 'private thought' },
          { id: 'text-2', type: 'text', text: 'after tool' },
        ],
      },
    ];

    expect(
      reconcileOpenCodeMessages(messages, {
        sessionId: 'session-active',
        baselineMessageIds: new Set(['baseline']),
      })
    ).toMatchObject({
      content: 'before tool\nafter tool',
      contentBlocks: [
        { type: 'text', text: 'before tool' },
        { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } },
        { type: 'tool_result', tool_use_id: 'call-1', content: '/worktree' },
        { type: 'thinking', text: 'private thought' },
        { type: 'text', text: 'after tool' },
      ],
      toolUses: [{ id: 'call-1', name: 'bash', input: { command: 'pwd' } }],
    });
  });

  it('fails when the completed transcript has no new assistant message', () => {
    expect(() =>
      reconcileOpenCodeMessages([], {
        sessionId: 'session-active',
        baselineMessageIds: new Set(),
      })
    ).toThrow('no new assistant output');
  });

  it('rejects step-only and empty assistant output as non-renderable', () => {
    for (const parts of [
      [
        {
          id: 'step-1',
          type: 'step-finish',
          cost: 0.01,
          tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
      [{ id: 'text-empty', type: 'text', text: '' }],
    ]) {
      expect(() =>
        reconcileOpenCodeMessages(
          [
            {
              info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
              parts,
            },
          ],
          { sessionId: 'session-active', baselineMessageIds: new Set() }
        )
      ).toThrow('no renderable content');
    }
  });

  it('aggregates step-finish cost, token, and cache metrics', () => {
    const result = reconcileOpenCodeMessages(
      [
        {
          info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
          parts: [
            { id: 'text-1', type: 'text', text: 'done' },
            {
              id: 'step-1',
              type: 'step-finish',
              cost: 0.01,
              tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
            },
          ],
        },
        {
          info: { id: 'assistant-2', sessionID: 'session-active', role: 'assistant' },
          parts: [
            {
              id: 'step-2',
              type: 'step-finish',
              cost: 0.02,
              tokens: { input: 20, output: 6, reasoning: 3, cache: { read: 7, write: 2 } },
            },
          ],
        },
      ],
      { sessionId: 'session-active', baselineMessageIds: new Set() }
    );

    expect(result.metadata).toEqual({
      opencode: {
        messageIds: ['assistant-1', 'assistant-2'],
        cost: 0.03,
        tokens: {
          input: 30,
          output: 10,
          reasoning: 5,
          cache: { read: 10, write: 3 },
        },
      },
    });
  });

  it('uses reasoning as the textual fallback for reasoning-only output', () => {
    const result = reconcileOpenCodeMessages(
      [
        {
          info: { id: 'assistant-1', sessionID: 'session-active', role: 'assistant' },
          parts: [{ id: 'reasoning-1', type: 'reasoning', text: 'reasoned answer' }],
        },
      ],
      { sessionId: 'session-active', baselineMessageIds: new Set() }
    );

    expect(result).toMatchObject({
      content: 'reasoned answer',
      contentBlocks: [{ type: 'thinking', text: 'reasoned answer' }],
    });
  });
});
