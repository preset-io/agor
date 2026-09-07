import { type Message, TaskStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { deriveLatestTodos, StickyTodoRenderer } from './StickyTodoRenderer';

function message(index: number, content: Array<Record<string, unknown>>): Message {
  return {
    message_id: `message-${index}`,
    session_id: 'session-1',
    task_id: 'task-1',
    type: index % 2 === 0 ? 'assistant' : 'user',
    role: index % 2 === 0 ? 'assistant' : 'user',
    index,
    timestamp: new Date(index * 1000).toISOString(),
    content_preview: '',
    content,
  } as Message;
}

describe('StickyTodoRenderer provider task shapes', () => {
  it('keeps rendering Codex normalized TodoWrite snapshots', () => {
    const messages = [
      message(0, [
        {
          type: 'tool_use',
          id: 'todo-1',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'First step', activeForm: 'Doing first step', status: 'completed' },
              { content: 'Second step', activeForm: 'Doing second step', status: 'in_progress' },
            ],
          },
        },
      ]),
    ];

    expect(deriveLatestTodos(messages)).toEqual([
      { content: 'First step', activeForm: 'Doing first step', status: 'completed' },
      { content: 'Second step', activeForm: 'Doing second step', status: 'in_progress' },
    ]);
  });

  it('correlates Claude TaskCreate output and folds TaskUpdate calls', () => {
    const messages = [
      message(0, [
        {
          type: 'tool_use',
          id: 'create-1',
          name: 'TaskCreate',
          input: { subject: 'Verify the fix', activeForm: 'Verifying the fix' },
        },
      ]),
      message(1, [
        {
          type: 'tool_result',
          tool_use_id: 'create-1',
          content: 'Task created',
          tool_use_result: { task: { id: 'task-7', subject: 'Verify the fix' } },
        },
      ]),
      message(2, [
        {
          type: 'tool_use',
          id: 'update-1',
          name: 'TaskUpdate',
          input: { taskId: 'task-7', status: 'in_progress', active_form: 'Checking it' },
        },
      ]),
      message(3, [{ type: 'tool_result', tool_use_id: 'update-1', content: 'Task updated' }]),
      message(4, [
        {
          type: 'tool_use',
          id: 'update-2',
          name: 'TaskUpdate',
          input: { task_id: 'task-7', status: 'completed' },
        },
      ]),
      message(5, [
        {
          type: 'tool_result',
          tool_use_id: 'update-2',
          content: 'Task updated',
          tool_use_result: { success: true, taskId: 'task-7', updatedFields: ['status'] },
        },
      ]),
    ];

    expect(deriveLatestTodos(messages)).toEqual([
      {
        id: 'task-7',
        content: 'Verify the fix',
        activeForm: 'Checking it',
        status: 'completed',
      },
    ]);

    render(<StickyTodoRenderer messages={messages} taskStatus={TaskStatus.COMPLETED} />);
    expect(screen.getByText('Task List')).toBeInTheDocument();
    expect(screen.getByText('1/1 completed')).toBeInTheDocument();
    expect(screen.getByText('Verify the fix')).toBeInTheDocument();
  });

  it('shows an optimistic TaskCreate and removes it when the tool result fails', () => {
    const create = message(0, [
      {
        type: 'tool_use',
        id: 'create-1',
        name: 'TaskCreate',
        input: { subject: 'Temporary task' },
      },
    ]);
    expect(deriveLatestTodos([create])).toEqual([
      {
        id: 'pending:create-1',
        content: 'Temporary task',
        activeForm: 'Temporary task',
        status: 'pending',
      },
    ]);

    const failed = message(1, [
      {
        type: 'tool_result',
        tool_use_id: 'create-1',
        content: 'failed',
        is_error: true,
      },
    ]);
    expect(deriveLatestTodos([create, failed])).toBeNull();
  });
});
