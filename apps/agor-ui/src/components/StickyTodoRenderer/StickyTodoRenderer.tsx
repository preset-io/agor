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

import type { Message } from '@agor/core/types';
import { theme } from 'antd';
import { useMemo } from 'react';
import { parseTodosInput, TodoListRenderer } from '../ToolUseRenderer/renderers/TodoListRenderer';

interface StickyTodoRendererProps {
  /**
   * Messages from the task - will be scanned in reverse to find latest TodoWrite
   */
  messages: Message[];
}

/**
 * Virtual component that scans backward through messages to find and display
 * the latest TodoWrite tool use. Renders nothing if no TODOs found.
 *
 * Performance: Uses useMemo + early exit strategy (O(1) to O(5) in practice)
 */
export function StickyTodoRenderer({ messages }: StickyTodoRendererProps) {
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

  // Don't render if no TODOs found
  if (!latestTodo) return null;

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
      <TodoListRenderer toolUseId="sticky-todo" input={{ todos: latestTodo }} />
    </div>
  );
}
