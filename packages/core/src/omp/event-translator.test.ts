import { describe, expect, it } from 'vitest';
import { isSlashCommandPrompt, OmpTurnAccumulator } from './event-translator.js';
import type { OmpFrame } from './event-types.js';

/** Build the assistant `message_end` frame OMP emits at the end of a message. */
function assistantEnd(overrides: Record<string, unknown> = {}): OmpFrame {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      model: 'claude-opus-5',
      provider: 'anthropic',
      stopReason: 'stop',
      ...overrides,
    },
  } as OmpFrame;
}

describe('OmpTurnAccumulator', () => {
  it('streams text deltas and ignores non-delta updates', () => {
    const acc = new OmpTurnAccumulator();
    expect(
      acc.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as OmpFrame)
    ).toEqual({ kind: 'text', text: 'Hello' });

    expect(
      acc.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' },
      } as OmpFrame)
    ).toEqual({ kind: 'thinking', text: 'pondering' });

    // Start/end markers carry no text and must not produce a chunk.
    expect(
      acc.handle({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
      } as OmpFrame)
    ).toBeUndefined();
  });

  it('builds tool_use and tool_result blocks from execution events', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'a.txt' },
      intent: 'Reading a.txt',
    } as OmpFrame);
    acc.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'file body' }] },
      isError: false,
    } as OmpFrame);

    const { contentBlocks, toolUses } = acc.result();
    expect(contentBlocks).toEqual([
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'read',
        input: { path: 'a.txt' },
        intent: 'Reading a.txt',
      },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'file body', is_error: false },
    ]);
    expect(toolUses).toEqual([{ id: 'call-1', name: 'read', input: { path: 'a.txt' } }]);
  });

  it('does not duplicate a tool block when a start frame repeats', () => {
    const acc = new OmpTurnAccumulator();
    const start = {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: {},
    } as OmpFrame;
    acc.handle(start);
    acc.handle(start);
    expect(acc.result().toolUses).toHaveLength(1);
  });

  it('does not emit an orphan tool_result when an end frame repeats', () => {
    // Asymmetric dedup used to let a retried end frame append a second
    // tool_result with no matching tool_use.
    const acc = new OmpTurnAccumulator();
    const end = {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'body' }] },
    } as OmpFrame;
    acc.handle(end);
    acc.handle(end);
    const results = acc.result().contentBlocks.filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(1);
  });

  it('treats a failing tool as normal progress, not a failed turn', () => {
    // Agents routinely probe, hit an error, and adapt. Only transport/agent
    // failures may set hadError, otherwise every exploratory turn fails.
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'missing.txt' },
    } as OmpFrame);
    acc.handle({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'ENOENT' }] },
      isError: true,
    } as OmpFrame);
    acc.handle({ type: 'agent_end' } as OmpFrame);

    const result = acc.result();
    expect(result.hadError).toBe(false);
    expect(result.contentBlocks).toContainEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: 'ENOENT',
      is_error: true,
    });
  });

  it('flags extension and transport errors as a failed turn', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle({ type: 'extension_error', error: 'boom' } as OmpFrame);
    expect(acc.result().hadError).toBe(true);

    const other = new OmpTurnAccumulator();
    other.recordError('spawn failed');
    expect(other.result().errorDetails).toEqual(['spawn failed']);
  });

  it('sums token usage and real USD cost across messages in a turn', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle(
      assistantEnd({
        usage: {
          input: 2,
          output: 100,
          cacheRead: 0,
          cacheWrite: 50,
          totalTokens: 152,
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0.3, total: 0.6 },
        },
      })
    );
    acc.handle(
      assistantEnd({
        usage: {
          input: 3,
          output: 7,
          cacheRead: 150,
          cacheWrite: 1,
          totalTokens: 161,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 },
        },
      })
    );

    expect(acc.result().usage).toEqual({
      inputTokens: 5,
      outputTokens: 107,
      cacheReadTokens: 150,
      cacheCreationTokens: 51,
      totalTokens: 313,
      costUsd: 1,
    });
  });

  it('records the model and stop reason from the assistant message', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle(assistantEnd());
    const result = acc.result();
    expect(result.model).toBe('claude-opus-5');
    expect(result.provider).toBe('anthropic');
    expect(result.stopReason).toBe('stop');
  });

  it('ignores user messages so the transcript is not duplicated', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'my prompt' }] },
    } as OmpFrame);
    expect(acc.result().contentBlocks).toEqual([]);
  });

  it('captures slash-command output as a text block', () => {
    // Local-only commands never invoke the agent; their output arrives on the
    // command_output side channel and is the entire visible result.
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'command_output',
      text: 'Current model: anthropic/claude-opus-5',
    } as OmpFrame);
    const result = acc.result();
    expect(result.commandOutputs).toEqual(['Current model: anthropic/claude-opus-5']);
    expect(result.contentBlocks).toEqual([
      { type: 'text', text: 'Current model: anthropic/claude-opus-5' },
    ]);
  });

  it('collects advertised slash commands for composer autocomplete', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'available_commands_update',
      commands: [
        { name: 'model', description: 'Show current model selection', source: 'builtin' },
        { name: 'usage', description: 'Show usage', source: 'builtin' },
      ],
    } as OmpFrame);
    expect(acc.result().slashCommands).toEqual(['model', 'usage']);
  });

  it('replaces the command set when OMP re-advertises it', () => {
    // OMP re-emits on change; keeping both sets would surface stale commands.
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'available_commands_update',
      commands: [{ name: 'old' }],
    } as OmpFrame);
    acc.handle({
      type: 'available_commands_update',
      commands: [{ name: 'fresh' }],
    } as OmpFrame);
    expect(acc.result().slashCommands).toEqual(['fresh']);
  });

  it('ignores malformed command entries without dropping valid ones', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle({
      type: 'available_commands_update',
      commands: [{ name: 'good' }, { description: 'no name' }, null, { name: '' }],
    } as OmpFrame);
    expect(acc.result().slashCommands).toEqual(['good']);
  });

  it('marks the turn ended on agent_end and via markEnded', () => {
    const viaAgent = new OmpTurnAccumulator();
    expect(viaAgent.isEnded).toBe(false);
    viaAgent.handle({ type: 'agent_end' } as OmpFrame);
    expect(viaAgent.isEnded).toBe(true);

    const viaLocal = new OmpTurnAccumulator();
    viaLocal.markEnded();
    expect(viaLocal.result().ended).toBe(true);
  });

  it('drops blank text and thinking blocks', () => {
    const acc = new OmpTurnAccumulator();
    acc.handle(
      assistantEnd({
        content: [
          { type: 'text', text: '   ' },
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'kept' },
        ],
      })
    );
    expect(acc.result().contentBlocks).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('tolerates unknown and malformed frames', () => {
    const acc = new OmpTurnAccumulator();
    expect(() => {
      acc.handle({ type: 'some_future_frame', payload: 1 } as OmpFrame);
      acc.handle({ type: 'message_end' } as OmpFrame);
      acc.handle({ type: 'tool_execution_end', toolCallId: 'x' } as OmpFrame);
    }).not.toThrow();
  });
});

describe('isSlashCommandPrompt', () => {
  it('detects slash commands, including leading whitespace', () => {
    expect(isSlashCommandPrompt('/model')).toBe(true);
    expect(isSlashCommandPrompt('  /usage')).toBe(true);
  });

  it('treats ordinary prompts and paths as non-commands', () => {
    expect(isSlashCommandPrompt('fix the bug')).toBe(false);
    expect(isSlashCommandPrompt('what does a/b do?')).toBe(false);
  });
});
