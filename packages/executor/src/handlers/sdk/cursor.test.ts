import { describe, expect, it, vi } from 'vitest';
import {
  buildCursorAssistantContent,
  normalizeCursorToolInput,
  normalizeCursorToolName,
  reportCursorActivity,
} from './cursor.js';

describe('Cursor SDK handler helpers', () => {
  it('persists thinking before assistant text', () => {
    expect(
      buildCursorAssistantContent({
        thinkingText: 'Reasoning trace',
        text: 'Final answer',
      })
    ).toEqual([
      { type: 'thinking', text: 'Reasoning trace' },
      { type: 'text', text: 'Final answer' },
    ]);
  });

  it('does not persist a thinking block that duplicates the final answer', () => {
    expect(
      buildCursorAssistantContent({
        thinkingText: 'Hello!  How can I help you today?',
        text: 'Hello! How can I help you today?',
      })
    ).toEqual([{ type: 'text', text: 'Hello! How can I help you today?' }]);
  });

  it('normalizes shell commands for existing Bash tool widgets', () => {
    const input = normalizeCursorToolInput({
      type: 'tool_call',
      call_id: 'call-1',
      name: 'run_terminal_cmd',
      status: 'running',
      args: { cmd: 'pnpm check' },
    } as never);

    expect(normalizeCursorToolName('run_terminal_cmd')).toBe('Bash');
    expect(input).toMatchObject({
      command: 'pnpm check',
      cursor_tool_name: 'run_terminal_cmd',
      status: 'running',
    });
  });

  it('normalizes file paths for existing file tool widgets', () => {
    const input = normalizeCursorToolInput({
      type: 'tool_call',
      call_id: 'call-2',
      name: 'edit',
      status: 'completed',
      args: { path: 'packages/executor/src/handlers/sdk/cursor.ts' },
    } as never);

    expect(normalizeCursorToolName('edit')).toBe('Edit');
    expect(input).toMatchObject({
      file_path: 'packages/executor/src/handlers/sdk/cursor.ts',
      cursor_tool_name: 'edit',
      status: 'completed',
    });
  });

  it.each([
    { type: 'system' },
    { type: 'user' },
    { type: 'status', status: 'CREATING' },
    { type: 'status', status: 'RUNNING' },
  ])('keeps Cursor initialization as startup activity %#', (event) => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, event as never);
    expect(onActivity).toHaveBeenCalledWith('sdk_started', event.type);
  });

  it.each([
    { type: 'assistant' },
    { type: 'thinking' },
    { type: 'tool_call' },
    { type: 'task' },
    { type: 'usage' },
    { type: 'status', status: 'FINISHED' },
  ])('recognizes meaningful Cursor progress %#', (event) => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, event as never);
    expect(onActivity).toHaveBeenCalledWith('progress', event.type);
  });

  it('keeps unreviewed Cursor request events fail-open', () => {
    const onActivity = vi.fn();
    reportCursorActivity(onActivity, { type: 'request' } as never);
    expect(onActivity).toHaveBeenCalledWith('unknown_activity', 'request');
  });
});
