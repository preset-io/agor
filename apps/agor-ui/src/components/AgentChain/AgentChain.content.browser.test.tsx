import { generateId } from '@agor/core/ids/browser';
import { type ContentBlock, type Message, MessageRole } from '@agor-live/client';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { AgentChain } from './AgentChain';

afterEach(cleanup);

function message(content: Message['content'], overrides: Partial<Message> = {}): Message {
  return {
    message_id: generateId(),
    session_id: generateId(),
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: 0,
    timestamp: '2026-09-22T00:00:00.000Z',
    content_preview: '',
    content,
    ...overrides,
  };
}

// ContentBlock's fields are unknown, not guaranteed strings. In particular,
// Claude's processContentBlocks can produce thinking with undefined text.
it.each<ContentBlock>([
  { type: 'text' },
  { type: 'thinking', signature: 'synthetic-signature' },
  { type: 'text', text: null },
  { type: 'thinking', text: 42, thinking: {} },
  { type: 'text', text: {}, thinking: 'Not a text-block field' },
  { type: 'thinking', text: ' \n\t ' },
])('renders through an empty or non-string block: %j', async (block) => {
  render(<AgentChain messages={[message([block, { type: 'text', text: 'Surviving thought' }])]} />);
  await userEvent.click(screen.getByRole('button', { name: 'Reasoning', expanded: false }));
  expect(screen.getByText('Surviving thought')).toBeVisible();
  expect(screen.getAllByText('Thinking', { exact: true })).toHaveLength(1);
  expect(screen.queryByText('Not a text-block field')).not.toBeInTheDocument();
});

it('preserves normalized and provider thinking, text, tool order, pairing and omission notices', async () => {
  const call = message([
    { type: 'text', text: '  Before tools  ' },
    // Codex reasoning and Cursor assistant-content normalization use .text.
    { type: 'thinking', text: 'Normalized reasoning' },
    { type: 'tool_use', id: 'first', name: 'Read', input: { file_path: 'first.txt' } },
    // Claude SDK ThinkingBlock uses .thinking, not .text.
    { type: 'thinking', thinking: 'Provider reasoning', signature: 'synthetic-signature' },
    { type: 'tool_use', id: 'second', name: 'Read', input: { file_path: 'second.txt' } },
    { type: 'text', text: 'After tools' },
  ]);
  const results = message(
    [
      // Deliberately reverse result order to check ID pairing, not positional pairing.
      { type: 'tool_result', tool_use_id: 'second', content: 'Second result', is_error: true },
      {
        type: 'tool_result',
        tool_use_id: 'first',
        content: 'First result',
        transcript_truncation: { content: { original_bytes: 900_000 } },
      },
    ],
    { session_id: call.session_id, role: MessageRole.USER, type: 'user', index: 1 }
  );
  render(<AgentChain messages={[call, results]} />);
  await userEvent.click(screen.getByRole('button', { name: '2 tool calls · Errors' }));
  const before = screen.getByText('Before tools');
  const normalized = screen.getByText('Normalized reasoning');
  const [first, second] = screen.getAllByRole('button', { name: /Read/ });
  const provider = screen.getByText('Provider reasoning');
  const after = screen.getByText('After tools');
  // Preserve AgentChain's existing before-tools / tools / after-tools grouping.
  for (const [a, b] of [
    [before, normalized],
    [normalized, first],
    [first, second],
    [second, provider],
    [provider, after],
  ]) {
    expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(screen.queryByRole('note')).not.toBeInTheDocument();
  await userEvent.click(first);
  expect(within(first.parentElement!).getByText('First result')).toBeVisible();
  expect(within(first.parentElement!).queryByText('Second result')).not.toBeInTheDocument();
  expect(screen.getAllByRole('note')).toHaveLength(1);
  expect(screen.getByRole('note')).toHaveTextContent('Transcript shortened: content');
  expect(screen.getByRole('note')).toHaveTextContent('execution was not changed');
  await userEvent.click(second);
  expect(within(second.parentElement!).getByText('Second result')).toBeVisible();
  expect(within(second.parentElement!).queryByText('First result')).not.toBeInTheDocument();
});

it('handles lean, partial and hydrated replacements without losing supported reasoning', async () => {
  // Lean SQL removes whole thinking blocks and sets this hint; it does not
  // manufacture text-less blocks. This tests replacements, not crash provenance.
  const lean = message([], { has_deferred_reasoning: true });
  const { container, rerender } = render(<AgentChain messages={[lean]} />);
  expect(container).toBeEmptyDOMElement();
  rerender(<AgentChain messages={[{ ...lean, content: [{ type: 'thinking' }] }]} />);
  expect(container).toBeEmptyDOMElement();
  rerender(
    <AgentChain
      messages={[
        { ...lean, content: [{ type: 'thinking', text: null, thinking: 'Hydrated reasoning' }] },
      ]}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
  expect(screen.getByText('Hydrated reasoning')).toBeVisible();
  rerender(
    <AgentChain
      messages={[
        {
          ...lean,
          content: [{ type: 'thinking', text: 'Normalized wins', thinking: 'Alternate' }],
        },
      ]}
    />
  );
  expect(screen.getByText('Normalized wins')).toBeVisible();
  expect(screen.queryByText('Alternate')).not.toBeInTheDocument();
  rerender(<AgentChain messages={[{ ...lean, content: 'String thought' }]} />);
  expect(screen.getByText('String thought')).toBeVisible();
});
