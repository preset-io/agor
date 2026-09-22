import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MessageBlock } from '../MessageBlock';
import { AgentChain } from './AgentChain';

vi.mock('../ToolUseRenderer', () => ({
  ToolUseRenderer: ({ toolUse }: { toolUse: { name: string } }) => (
    <div data-testid="tool-body">{toolUse.name} body</div>
  ),
}));
afterEach(cleanup);
const sessionId = generateId();
function activity(name: string, index: number, complete = false): Message {
  return {
    message_id: generateId(),
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index,
    timestamp: '2026-09-01T00:00:00.000Z',
    content_preview: '',
    content: [
      { type: 'tool_use', id: `call-${index}`, name, input: {} },
      ...(complete
        ? [{ type: 'tool_result' as const, tool_use_id: `call-${index}`, content: 'Result' }]
        : []),
    ],
  };
}
it('updates a quiet collapsed header from live activity to a known count without forcing it open', () => {
  const first = activity('Read', 0, true);
  const { container, rerender } = render(
    <AgentChain messages={[first]} isTaskRunning isLatest leanTranscript />
  );
  expect(screen.getByRole('button', { name: 'Latest: Read', expanded: false })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  rerender(
    <AgentChain messages={[first, activity('Bash', 1)]} isTaskRunning isLatest leanTranscript />
  );
  expect(screen.getByRole('button', { name: 'Running: Bash', expanded: false })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  rerender(<AgentChain messages={[first, activity('Bash', 1, true)]} isLatest leanTranscript />);
  const header = screen.getByRole('button', { name: '2 tool calls', expanded: false });
  expect(header).toHaveAttribute('aria-expanded', 'false');
  expect(container.querySelector('.ant-tag')).toBeNull();
  expect(header).toHaveAttribute('aria-busy', 'false');
  expect(screen.queryByText('Result')).not.toBeInTheDocument();
  fireEvent.click(header);
  expect(screen.getByRole('button', { name: /Read/ })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: '2 tool calls', expanded: true }));
  expect(screen.getByRole('button', { name: '2 tool calls', expanded: false })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});

it.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'edit_files'])(
  'restores %s body defaults inside the closed outer group and direct message renderer',
  (name) => {
    const message = activity(name, 0, true);
    const { unmount } = render(<AgentChain messages={[message]} leanTranscript />);
    expect(screen.queryByTestId('tool-body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 tool call', expanded: false }));
    expect(screen.getByTestId('tool-body')).toBeVisible();
    unmount();
    render(<MessageBlock message={message} leanTranscript />);
    expect(screen.getByTestId('tool-body')).toBeVisible();
  }
);
