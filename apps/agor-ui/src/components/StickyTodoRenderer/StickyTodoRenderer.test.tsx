import { type Message, TaskStatus } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { projectMessageData } from '../../../../../packages/executor/src/services/tool-result-truncator';
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

describe('StickyTodoRenderer persisted projections', () => {
  const todos = [
    { content: 'First step', activeForm: 'Doing first step', status: 'completed' },
    { content: 'Second step', activeForm: 'Doing second step', status: 'pending' },
  ];
  const snapshot = message(0, [
    { type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos } },
  ]);

  function persist(source: Message): Message {
    return JSON.parse(JSON.stringify(projectMessageData(source, 800_000)));
  }

  function omittedSnapshot() {
    return persist(
      message(2, [
        {
          type: 'tool_use',
          id: 'todo-2',
          name: 'TodoWrite',
          input: { todos: [{ ...todos[0], activeForm: 'x'.repeat(810_000) }, todos[1]] },
        },
      ])
    );
  }

  function expectUnavailable() {
    expect(screen.getByRole('note')).toBeVisible();
    expect(screen.getByRole('note')).toHaveTextContent('Current task list unavailable');
    expect(screen.getByRole('note')).toHaveTextContent('serialized bytes');
    expect(screen.queryByText('Task List')).not.toBeInTheDocument();
    expect(screen.queryByText('First step')).not.toBeInTheDocument();
    expect(screen.queryByText(/completed$/)).not.toBeInTheDocument();
  }

  it.each([false, true])(
    'shows unavailable, not empty/current, with prior snapshot=%s',
    (hasPrior) => {
      const prior = hasPrior ? [persist(snapshot)] : [];
      const { rerender } = render(
        <StickyTodoRenderer messages={prior} taskStatus={TaskStatus.RUNNING} />
      );
      if (hasPrior) expect(screen.getByText('First step')).toBeVisible();
      const projected = omittedSnapshot();
      expect(
        Array.isArray(projected.content) && projected.content[0].transcript_truncation?.input
      ).toBeTruthy();
      rerender(
        <StickyTodoRenderer messages={[...prior, projected]} taskStatus={TaskStatus.RUNNING} />
      );
      expectUnavailable();

      // A later, complete snapshot restores a known current list.
      rerender(
        <StickyTodoRenderer
          messages={[...prior, projected, persist(snapshot)]}
          taskStatus={TaskStatus.RUNNING}
        />
      );
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
      expect(screen.getByText('First step')).toBeVisible();
      expect(screen.getByText('Second step')).toBeVisible();
      expect(screen.getByText('1/2 completed')).toBeVisible();
    }
  );

  it.each([false, true])('honors normal empty snapshots after omission=%s', (afterOmission) => {
    const prior = [persist(snapshot), ...(afterOmission ? [omittedSnapshot()] : [])];
    const empty = persist(
      message(4, [{ type: 'tool_use', id: 'empty', name: 'TodoWrite', input: { todos: [] } }])
    );
    const { rerender, container } = render(
      <StickyTodoRenderer messages={prior} taskStatus={TaskStatus.RUNNING} />
    );
    rerender(<StickyTodoRenderer messages={[...prior, empty]} taskStatus={TaskStatus.RUNNING} />);
    expect(deriveLatestTodos([...prior, empty])).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  const listCall = message(0, [{ type: 'tool_use', id: 'list', name: 'TaskList', input: {} }]);
  const listResult = message(1, [
    {
      type: 'tool_result',
      tool_use_id: 'list',
      content: 'Listed tasks',
      tool_use_result: {
        tasks: todos.map((todo, index) => ({
          id: String(index),
          subject: todo.content,
          status: todo.status,
        })),
      },
    },
  ]);

  it.each(['TaskCreate', 'TaskUpdate'])(
    'does not present stale state after omitted %s input',
    (name) => {
      const source = message(2, [
        {
          type: 'tool_use',
          id: 'change',
          name,
          input: {
            taskId: '0',
            subject: 'Changed task',
            status: 'in_progress',
            description: 'x'.repeat(810_000),
          },
        },
      ]);
      const projected = persist(source);
      const messages = [persist(listCall), persist(listResult), projected];
      render(<StickyTodoRenderer messages={messages} taskStatus={TaskStatus.RUNNING} />);
      expectUnavailable();
      expect(source.content).not.toEqual(projected.content);

      // A late result still has unavailable input even if a snapshot intervenes.
      const lateResult = persist(
        message(5, [{ type: 'tool_result', tool_use_id: 'change', content: 'Updated' }])
      );
      expect(
        deriveLatestTodos([...messages, persist(listCall), persist(listResult), lateResult])
      ).toHaveProperty('unavailable.input');
    }
  );

  it.each([
    ['TaskCreate', 'tool_use_result'],
    ['TaskUpdate', 'tool_use_result'],
    ['TaskGet', 'tool_use_result'],
    ['TaskList', 'tool_use_result'],
    ['TaskCreate', 'content'],
    ['TaskUpdate', 'content'],
    ['TaskGet', 'content'],
    ['TaskList', 'content'],
  ])('does not fold projected %s %s as complete state', (name, field) => {
    const call = persist(
      message(2, [
        {
          type: 'tool_use',
          id: 'next',
          name,
          input: { taskId: '0', subject: 'Changed task', status: 'completed' },
        },
      ])
    );
    const output = { tasks: [], success: false, detail: 'x'.repeat(810_000) };
    const result = persist(
      message(3, [
        {
          type: 'tool_result',
          tool_use_id: 'next',
          ...(field === 'content'
            ? { content: JSON.stringify(output) }
            : { content: 'Task result', tool_use_result: output }),
        },
      ])
    );
    expect(
      Array.isArray(result.content) && result.content[0].transcript_truncation?.[field]
    ).toBeTruthy();
    const messages = [persist(listCall), persist(listResult), call, result];
    const { rerender, container } = render(
      <StickyTodoRenderer messages={messages} taskStatus={TaskStatus.RUNNING} />
    );
    expectUnavailable();

    // A complete TaskGet updates one task, not the missing full snapshot.
    const getCall = persist(
      message(4, [{ type: 'tool_use', id: 'get', name: 'TaskGet', input: { taskId: '0' } }])
    );
    const getResult = persist(
      message(5, [
        {
          type: 'tool_result',
          tool_use_id: 'get',
          content: JSON.stringify({
            task: { id: '0', subject: 'First step', status: 'completed' },
          }),
        },
      ])
    );
    rerender(
      <StickyTodoRenderer
        messages={[...messages, getCall, getResult]}
        taskStatus={TaskStatus.RUNNING}
      />
    );
    expectUnavailable();

    // Full TaskList snapshots recover known populated and known empty state.
    rerender(
      <StickyTodoRenderer
        messages={[...messages, persist(listCall), persist(listResult)]}
        taskStatus={TaskStatus.RUNNING}
      />
    );
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByText('First step')).toBeVisible();
    const empty = persist(
      message(5, [{ type: 'tool_result', tool_use_id: 'list', content: '{"tasks":[]}' }])
    );
    rerender(
      <StickyTodoRenderer
        messages={[...messages, persist(listCall), empty]}
        taskStatus={TaskStatus.RUNNING}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('ignores projected irrelevant fields and uses intact structured results over shortened text', () => {
    const result = persist(
      message(1, [
        {
          type: 'tool_result',
          tool_use_id: 'list',
          content: 'x'.repeat(810_000),
          tool_use_result: { tasks: [{ id: '0', subject: 'First step', status: 'pending' }] },
        },
      ])
    );
    const unrelated = persist(
      message(2, [
        { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'x'.repeat(810_000) } },
      ])
    );
    render(
      <StickyTodoRenderer
        messages={[persist(listCall), result, unrelated]}
        taskStatus={TaskStatus.RUNNING}
      />
    );
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByText('First step')).toBeVisible();
  });
});
