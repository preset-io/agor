import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { projectMessageData } from '../../../../../packages/executor/src/services/tool-result-truncator';
import { groupMessagesIntoBlocks } from '../TaskBlock/TaskBlock';
import { MessageBlock } from './MessageBlock';

describe('MessageBlock persisted Task projections', () => {
  it('keeps the omission notice visible through the Task-only message route', () => {
    const input = {
      subagent_type: 'general-purpose',
      description: 'Synthetic task',
      prompt: 'x'.repeat(500_000),
    };
    const source: Message = {
      message_id: generateId(),
      session_id: generateId(),
      task_id: generateId(),
      type: 'assistant',
      role: MessageRole.ASSISTANT,
      index: 0,
      timestamp: '2026-09-14T00:00:00.000Z',
      content_preview: '',
      content: [{ type: 'tool_use', id: 'task-tool', name: 'Task', input }],
      tool_uses: [{ id: 'task-tool', name: 'Task', input }],
    };
    const persisted: Message = JSON.parse(JSON.stringify(projectMessageData(source, 800_000)));
    const originalBytes = Buffer.byteLength(JSON.stringify(input));

    expect(persisted.tool_uses?.[0].transcript_truncation?.input.original_bytes).toBe(
      originalBytes
    );
    expect(groupMessagesIntoBlocks([persisted])).toEqual([{ type: 'message', message: persisted }]);
    render(<MessageBlock message={persisted} />);
    expect(screen.getByText(/Task \(Task\)/)).toBeVisible();
    expect(screen.getByRole('note')).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('Transcript shortened: input');
    expect(screen.getByRole('note')).toHaveTextContent(
      `${originalBytes.toLocaleString()} serialized bytes`
    );
    expect(screen.getByRole('note')).toHaveTextContent('execution was not changed');
    expect(input.prompt).toHaveLength(500_000);
    expect(source.tool_uses?.[0].input).toBe(input);
  });

  it('retains notices when a Task result is reconstructed as text', () => {
    const source: Message = {
      message_id: generateId(),
      session_id: generateId(),
      type: 'user',
      role: MessageRole.USER,
      index: 1,
      timestamp: '2026-09-14T00:00:01.000Z',
      content_preview: '',
      content: [{ type: 'tool_result', tool_use_id: 'task-tool', content: 'x'.repeat(810_000) }],
    };
    const persisted: Message = JSON.parse(JSON.stringify(projectMessageData(source, 1_000)));
    render(<MessageBlock message={persisted} />);
    expect(screen.getByRole('note')).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent(
      'content (originally 810,002 serialized bytes)'
    );
  });
});
