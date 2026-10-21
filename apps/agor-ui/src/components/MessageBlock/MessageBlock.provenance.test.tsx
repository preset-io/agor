import { generateId } from '@agor/core/ids/browser';
import { renderPromptProvenanceBlock } from '@agor/core/templates/prompt-provenance';
import {
  type Message,
  MessageRole,
  type SessionID,
  sessionPath,
  shortId,
  type TaskMetadata,
} from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskBlock } from '../TaskBlock/TaskBlock';
import { MessageBlock } from './MessageBlock';

const origin = '01a0d369-82f3-7458-8265-861a4752b7b2' as SessionID;
const block = renderPromptProvenanceBlock({
  origin: { sessionId: origin, sessionShortId: shortId(origin), agenticTool: 'claude-code' },
  userLabel: 'sender@example.invalid',
  authenticatedBy: 'session_token',
  tool: 'agor_sessions_prompt',
  mode: 'continue',
});
const provenance: NonNullable<TaskMetadata['prompt_provenance']> = {
  version: 1,
  authenticated_by: 'session_token',
  origin_session_id: origin,
  origin_user_id: generateId(),
  origin_agentic_tool: 'claude-code',
  tool: 'agor_sessions_prompt',
  mode: 'continue',
  stamped_at: '2026-10-21T00:00:00.000Z',
  rendered_block: block,
  placement: 'prefix',
};
const message = (content: Message['content'], metadata?: Message['metadata']): Message => ({
  message_id: generateId(),
  session_id: generateId(),
  type: 'user',
  role: MessageRole.USER,
  index: 0,
  timestamp: '2026-10-21T00:00:00.000Z',
  content_preview: '',
  content,
  metadata,
});
afterEach(cleanup);

function expectCompactLine() {
  expect(screen.getByRole('link', { name: shortId(origin) })).toHaveAttribute(
    'href',
    sessionPath(origin)
  );
  const expander = screen.getByRole('button', { name: /what the agent saw/ });
  expect(expander).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(/Server-stamped by Agor/)).not.toBeInTheDocument();
  expect(expander).toHaveTextContent('claude-code · via agor_sessions_prompt (continue)');
  expect(
    screen.queryByText((_, node) => node?.tagName === 'PRE' && node.textContent === block)
  ).not.toBeInTheDocument();
  expect(screen.getByText(/ship the branch$/, { selector: 'p' })).toBeVisible();
  fireEvent.click(expander);
  expect(
    screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === block)
  ).toBeVisible();
  fireEvent.click(expander);
  expect(expander).toHaveAttribute('aria-expanded', 'false');
}

describe('prompt provenance presentation', () => {
  it.each(['structured', 'legacy', 'array', 'suffix'] as const)(
    'renders %s provenance compactly with the original block on demand',
    (kind) => {
      const text =
        kind === 'suffix' ? `ship the branch\n\n${block}` : `${block}\n\nship the branch`;
      render(
        <MessageBlock
          message={message(
            kind === 'array' ? [{ type: 'text', text }] : text,
            kind === 'legacy' ? undefined : { prompt_provenance: provenance }
          )}
        />
      );
      expectCompactLine();
    }
  );

  it('links to the session under the mounted UI base path', () => {
    window.history.replaceState(null, '', '/ui/');
    try {
      render(<MessageBlock message={message(`${block}\n\nship the branch`)} />);
      expect(screen.getByRole('link', { name: shortId(origin) })).toHaveAttribute(
        'href',
        `/ui${sessionPath(origin)}`
      );
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps a block-only message available without repeating it in the body', () => {
    render(<MessageBlock message={message(block, { prompt_provenance: provenance })} />);
    expect(screen.queryByText(/Server-stamped by Agor/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /what the agent saw/ }));
    expect(
      screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === block)
    ).toBeVisible();
  });

  it('uses structured identity before the legacy text projection', () => {
    render(
      <MessageBlock
        message={message(`${block}\n\nship the branch`, {
          prompt_provenance: {
            ...provenance,
            origin_session_id: undefined,
            origin_agentic_tool: undefined,
          },
        })}
      />
    );
    expect(screen.getByText(/origin not established/)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders an unattributed legacy stamp without claiming an origin', () => {
    const unattributed = renderPromptProvenanceBlock({
      userLabel: 'sender@example.invalid',
      authenticatedBy: 'personal_api_key',
      tool: 'agor_sessions_create',
    });
    render(<MessageBlock message={message(`${unattributed}\n\nship the branch`)} />);
    expect(screen.getByText(/origin not established/)).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /what the agent saw/ }));
    expect(
      screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === unattributed)
    ).toBeVisible();
  });

  it.each([
    'ordinary message',
    'quoted &lt;agor_prompt_provenance&gt;not a stamp&lt;/agor_prompt_provenance&gt;',
  ])('leaves unstamped text unchanged: %s', (text) => {
    render(<MessageBlock message={message(text)} />);
    expect(screen.queryByRole('button', { name: /what the agent saw/ })).not.toBeInTheDocument();
    expect(screen.getByText(text.replaceAll('&lt;', '<').replaceAll('&gt;', '>'))).toBeVisible();
  });

  it.each([false, true])(
    'preserves provenance in the lean transcript (Task fallback: %s)',
    (fallback) => {
      const prompt = message(`${block}\n\nship the branch`, { prompt_provenance: provenance });
      render(
        <TaskBlock
          task={{
            task_id: generateId(),
            session_id: prompt.session_id,
            created_by: '',
            full_prompt: prompt.content as string,
            status: 'completed',
            created_at: prompt.timestamp,
            message_range: { start_index: 0, end_index: 0, start_timestamp: prompt.timestamp },
            git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
            metadata: { prompt_provenance: provenance },
          }}
          taskMessages={fallback ? [] : [prompt]}
          taskMessagesLoaded={false}
          onLoadTaskMessages={async () => {}}
        />
      );
      expectCompactLine();
    }
  );
});
