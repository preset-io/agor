/**
 * TodoListRenderer - Custom renderer for TodoWrite tool
 *
 * Displays Claude Code's todo list with:
 * - Visual checkboxes (✓ completed, □ in-progress, ○ pending)
 * - Status-aware coloring
 * - Clean, minimal design
 * - Compact inline display
 */

import { CheckCircleFilled } from '@ant-design/icons';
import { Spin, theme } from 'antd';
import type React from 'react';

export interface TodoItem {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

interface TodoWriteInput {
  todos: TodoItem[];
}

/**
 * Parse a todos value that may be either a TodoItem[] array or a JSON string.
 * Tool input from message data may arrive serialized; this normalizes both forms.
 */
export function parseTodosInput(raw: unknown): TodoItem[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Invalid JSON — fall through to empty
    }
  }
  return [];
}

interface TodoListRendererProps {
  /**
   * Tool use ID (for stable React keys)
   */
  toolUseId: string;

  /**
   * Tool input containing todos array
   */
  input: TodoWriteInput;
}

/**
 * Simple circle icon component (for pending state)
 */
const CircleIcon: React.FC<{ color: string }> = ({ color }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="Pending task"
  >
    <circle cx="7" cy="7" r="5.5" stroke={color} strokeWidth="1.5" />
  </svg>
);

/**
 * Renders a single todo item with status indicator
 */
const TodoItemRow: React.FC<{ todo: TodoItem; index: number }> = ({ todo, index }) => {
  const { token } = theme.useToken();

  // Determine icon and color based on status
  const getStatusIcon = () => {
    switch (todo.status) {
      case 'completed':
        return (
          <CheckCircleFilled
            style={{
              color: token.colorSuccess,
              fontSize: 14,
            }}
          />
        );
      case 'in_progress':
        return (
          <Spin
            size="small"
            style={{
              color: token.colorPrimary,
              fontSize: 14,
            }}
          />
        );
      default:
        return <CircleIcon color={token.colorTextSecondary} />;
    }
  };

  // Text styling based on status
  const getTextStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      fontSize: 13,
      lineHeight: '18px',
      margin: 0,
    };

    switch (todo.status) {
      case 'completed':
        return {
          ...baseStyle,
          color: token.colorTextSecondary,
          textDecoration: 'line-through',
        };
      case 'in_progress':
        return {
          ...baseStyle,
          color: token.colorText,
          fontWeight: 500,
        };
      default:
        return {
          ...baseStyle,
          color: token.colorTextSecondary,
        };
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.sizeUnit,
        padding: `${token.sizeUnit / 2}px 0`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          width: 14,
          height: 14,
        }}
      >
        {getStatusIcon()}
      </div>
      <p style={getTextStyle()}>{todo.content}</p>
    </div>
  );
};

/**
 * Main TodoListRenderer component
 */
export const TodoListRenderer: React.FC<TodoListRendererProps> = ({ toolUseId, input }) => {
  const { token } = theme.useToken();

  // Extract todos array — handles both parsed arrays and JSON strings
  const todos = parseTodosInput(input?.todos);

  if (todos.length === 0) {
    return null;
  }

  // Count statuses for summary
  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length;
  const totalCount = todos.length;

  return (
    <div
      style={{
        padding: token.sizeUnit * 1.5,
        borderRadius: token.borderRadius,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorder}`,
      }}
    >
      {/* Header with summary */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: token.sizeUnit,
          paddingBottom: token.sizeUnit,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: token.colorTextSecondary,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
          }}
        >
          Task List
        </span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextTertiary,
          }}
        >
          {completedCount}/{totalCount} completed
          {inProgressCount > 0 && ` • ${inProgressCount} in progress`}
        </span>
      </div>

      {/* Todo items */}
      <div>
        {todos.map((todo, index) => (
          <TodoItemRow
            key={`${toolUseId}-${todo.content.substring(0, 50)}`}
            todo={todo}
            index={index}
          />
        ))}
      </div>
    </div>
  );
};
