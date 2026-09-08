/**
 * StickyTodoRenderer - Displays latest TODO above typing indicator
 *
 * Reconstructs the latest list from either Codex/legacy TodoWrite snapshots or
 * Claude's TaskCreate/TaskUpdate lifecycle, then renders it above the typing
 * indicator.
 *
 * Features:
 * - Caches result with useMemo (dependency: messages)
 * - Reuses existing TodoListRenderer for consistent styling
 * - Subtle visual distinction (dashed border, light background)
 * - Only renders when TODOs exist (returns null otherwise)
 */

import { type Message, TaskStatus } from '@agor-live/client';
import { theme } from 'antd';
import { useMemo } from 'react';
import {
  parseTodosInput,
  type RenderableTodoItem,
  type RenderableTodoStatus,
  TodoListRenderer,
} from '../ToolUseRenderer/renderers/TodoListRenderer';

interface StickyTodoRendererProps {
  /**
   * Messages from the task, including provider tool-use and tool-result blocks.
   */
  messages: Message[];

  /**
   * Status of the parent task. Used to decide whether items still marked
   * `in_progress` should be displayed as `stopped` (user halted the task) or
   * `unknown` (task ended without the agent updating this item).
   */
  taskStatus: TaskStatus;
}

/**
 * If the parent task is no longer running, items still in `in_progress` cannot
 * truly be running. Map them to a display-only status that conveys what we
 * actually know:
 *
 * - User halted (STOPPED/STOPPING): we know the work didn't finish → 'stopped'
 * - Task ended otherwise (COMPLETED/FAILED/TIMED_OUT) without the agent
 *   updating this item: we don't know if it finished → 'unknown'
 * - Active/waiting states (RUNNING, CREATED, AWAITING_*): leave as-is
 */
function inProgressOverrideFor(taskStatus: TaskStatus): RenderableTodoStatus | null {
  switch (taskStatus) {
    case TaskStatus.STOPPED:
    case TaskStatus.STOPPING:
      return 'stopped';
    case TaskStatus.COMPLETED:
    case TaskStatus.FAILED:
    case TaskStatus.TIMED_OUT:
      return 'unknown';
    default:
      return null;
  }
}

type TaskToolName = 'taskcreate' | 'taskupdate' | 'taskget' | 'tasklist';

interface TaskTodo extends RenderableTodoItem {
  id: string;
}

interface TaskToolCall {
  name: TaskToolName;
  input: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function todoStatus(value: unknown): RenderableTodoStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    ? value
    : undefined;
}

function taskFromRecord(
  record: Record<string, unknown>,
  fallback?: TaskTodo
): TaskTodo | undefined {
  const id = stringField(record, 'id', 'taskId', 'task_id') ?? fallback?.id;
  const content = stringField(record, 'subject') ?? fallback?.content;
  if (!id || !content) return undefined;
  return {
    id,
    content,
    activeForm: stringField(record, 'activeForm', 'active_form') ?? fallback?.activeForm ?? content,
    status: todoStatus(record.status) ?? fallback?.status ?? 'pending',
  };
}

function structuredToolResult(block: Record<string, unknown>) {
  const structured = asRecord(block.tool_use_result);
  if (structured) return structured;

  // Some importers may serialize structured output into content. Prefer the
  // SDK field above, but accept a JSON object for durable historical records.
  if (typeof block.content === 'string') {
    try {
      return asRecord(JSON.parse(block.content));
    } catch {
      return undefined;
    }
  }
  return asRecord(block.content);
}

/**
 * Fold persisted tool calls/results into the latest renderable task list.
 *
 * TodoWrite is a complete snapshot (including Codex's normalized todo_list
 * event). Claude Task* calls are incremental and TaskCreate receives its ID in
 * the following SDKUserMessage.tool_use_result, so calls are correlated by
 * tool_use_id. This function is intentionally pure so hydrated and realtime
 * message arrays follow the same path.
 */
export function deriveLatestTodos(messages: Message[]): RenderableTodoItem[] | null {
  let mode: 'todo-write' | 'task-tools' | null = null;
  let todoWriteSnapshot: RenderableTodoItem[] = [];
  const tasks = new Map<string, TaskTodo>();
  const calls = new Map<string, TaskToolCall>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;

    for (const rawBlock of message.content) {
      const block = rawBlock as Record<string, unknown>;
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const name = block.name.toLowerCase();
        const input = asRecord(block.input) ?? {};

        if (name === 'todowrite') {
          if (mode !== 'todo-write') {
            tasks.clear();
            calls.clear();
          }
          mode = 'todo-write';
          todoWriteSnapshot = parseTodosInput(input.todos);
          continue;
        }

        if (!['taskcreate', 'taskupdate', 'taskget', 'tasklist'].includes(name)) continue;
        if (mode !== 'task-tools') {
          tasks.clear();
          calls.clear();
        }
        mode = 'task-tools';
        const toolUseId = typeof block.id === 'string' ? block.id : undefined;
        const toolName = name as TaskToolName;

        if (toolName === 'taskcreate' && toolUseId) {
          const subject = stringField(input, 'subject');
          if (subject) {
            tasks.set(`pending:${toolUseId}`, {
              id: `pending:${toolUseId}`,
              content: subject,
              activeForm: stringField(input, 'activeForm', 'active_form') ?? subject,
              status: 'pending',
            });
          }
        }

        if (toolName === 'taskupdate') {
          if (toolUseId) calls.set(toolUseId, { name: toolName, input });
          continue;
        }

        if (toolUseId) calls.set(toolUseId, { name: toolName, input });
        continue;
      }

      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const call = calls.get(block.tool_use_id);
      if (!call) continue;

      if (block.is_error === true) {
        if (call.name === 'taskcreate') tasks.delete(`pending:${block.tool_use_id}`);
        calls.delete(block.tool_use_id);
        continue;
      }

      const result = structuredToolResult(block);
      if (call.name === 'taskcreate') {
        const created = asRecord(result?.task) ?? result;
        const pending = tasks.get(`pending:${block.tool_use_id}`);
        const task = created ? taskFromRecord(created, pending) : undefined;
        if (task) {
          tasks.delete(`pending:${block.tool_use_id}`);
          tasks.set(task.id, task);
        }
      } else if (call.name === 'taskupdate' && result?.success !== false) {
        const taskId = stringField(call.input, 'taskId', 'task_id', 'id');
        if (taskId && call.input.status === 'deleted') {
          tasks.delete(taskId);
        } else if (taskId) {
          const updated = taskFromRecord(call.input, tasks.get(taskId));
          if (updated) tasks.set(taskId, updated);
        }
      } else if (call.name === 'taskget') {
        const returned = asRecord(result?.task) ?? result;
        const task = returned ? taskFromRecord(returned) : undefined;
        if (task) tasks.set(task.id, task);
      } else if (call.name === 'tasklist' && Array.isArray(result?.tasks)) {
        tasks.clear();
        for (const rawTask of result.tasks) {
          const taskRecord = asRecord(rawTask);
          const task = taskRecord ? taskFromRecord(taskRecord) : undefined;
          if (task) tasks.set(task.id, task);
        }
      }
      calls.delete(block.tool_use_id);
    }
  }

  const latest = mode === 'task-tools' ? Array.from(tasks.values()) : todoWriteSnapshot;
  return latest.length > 0 ? latest : null;
}

/**
 * Virtual component that derives and displays the latest task list. Renders
 * nothing if neither provider has produced task state.
 */
export function StickyTodoRenderer({ messages, taskStatus }: StickyTodoRendererProps) {
  const { token } = theme.useToken();

  const latestTodo = useMemo(() => deriveLatestTodos(messages), [messages]);

  // Apply display-only transform: items still `in_progress` are rewritten when
  // the parent task can no longer be making progress. Underlying message data
  // is untouched — historical tool blocks render the original status.
  const displayTodos = useMemo<RenderableTodoItem[] | null>(() => {
    if (!latestTodo) return null;
    const override = inProgressOverrideFor(taskStatus);
    if (!override) return latestTodo;
    return latestTodo.map((todo) =>
      todo.status === 'in_progress' ? { ...todo, status: override } : todo
    );
  }, [latestTodo, taskStatus]);

  // Don't render if no TODOs found
  if (!displayTodos) return null;

  return (
    <div
      style={{
        margin: `${token.sizeUnit}px 0`,
        padding: `${token.sizeXS}px`,
        background: token.colorBgContainerDisabled,
        borderRadius: token.borderRadiusSM,
        border: `1px dashed ${token.colorBorder}`,
        transition: 'opacity 0.3s ease',
      }}
    >
      <TodoListRenderer toolUseId="sticky-todo" input={{ todos: displayTodos }} />
    </div>
  );
}
