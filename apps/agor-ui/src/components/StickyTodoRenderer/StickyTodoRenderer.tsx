/**
 * StickyTodoRenderer - Displays latest TODO above typing indicator
 *
 * Scans backward through messages to find the latest TodoWrite tool use,
 * rendering it above the typing indicator when a task is running.
 *
 * Features:
 * - Scans messages in reverse for performance (early exit)
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
   * Messages from the task - will be scanned in reverse to find latest TodoWrite
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

/**
 * Virtual component that scans backward through messages to find and display
 * the latest TodoWrite tool use. Renders nothing if no TODOs found.
 *
 * Performance: Uses useMemo + early exit strategy (O(1) to O(5) in practice)
 */
export function StickyTodoRenderer({ messages, taskStatus }: StickyTodoRendererProps) {
  const { token } = theme.useToken();

  // Scan messages in reverse to find latest TodoWrite
  // Early exit on first match for performance
  const latestTodo = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];

      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_use' && block.name === 'TodoWrite') {
            // Found the latest TodoWrite - return its todos and exit immediately
            const input = block.input as Record<string, unknown> | undefined;
            const todos = parseTodosInput(input?.todos);
            return todos.length > 0 ? todos : null;
          }
        }
      }
    }
    return null;
  }, [messages]);

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
