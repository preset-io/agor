import { generateId } from '@agor/core/ids/browser';
import { renderPromptProvenanceBlock } from '@agor/core/templates/prompt-provenance';
import {
  type Message,
  MessageRole,
  type Session,
  type SessionID,
  sessionPath,
  shortId,
  type TaskMetadata,
} from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { TaskBlock } from '../TaskBlock/TaskBlock';
import { getMessageSpeaker, MessageBlock } from './MessageBlock';

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
const sender: Session = {
  session_id: origin,
  branch_id: generateId(),
  created_by: generateId(),
  agentic_tool: 'claude-code',
  status: 'idle',
  created_at: '2026-10-21T00:00:00.000Z',
  last_updated: '2026-10-21T00:00:00.000Z',
  unix_username: null,
  sdk_home_scope: 'branch',
  url: null,
  genealogy: { children: [] },
  tasks: [],
  scheduled_from_branch: false,
  ready_for_prompt: true,
  archived: false,
  title: 'Release planning',
};
const originalSessions = agorStore.getState().sessionById;
beforeEach(() => agorStore.setState({ sessionById: new Map([[origin, sender]]) }));
afterEach(() => {
  cleanup();
  agorStore.setState({ sessionById: originalSessions });
});

function expectCompactLine() {
  expect(screen.getByRole('link', { name: 'Open sender session' })).toHaveAttribute(
    'href',
    sessionPath(origin)
  );
  const expander = screen.getByRole('button', { name: /Details/ });
  expect(expander).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(/Server-stamped by Agor/)).not.toBeInTheDocument();
  expect(screen.getByText(/Sent by/)).toHaveTextContent(`Sent by ${sender.title}`);
  expect(
    screen.queryByText(/claude-code|agor_sessions_prompt|continue|01a0d369/)
  ).not.toBeInTheDocument();
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

  it.each(['missing', 'untitled', 'blank title'] as const)(
    'does not reveal a sender identity when the session is %s',
    (kind) => {
      const sessions =
        kind === 'missing'
          ? new Map<string, Session>()
          : new Map([
              [
                origin,
                {
                  ...sender,
                  title: kind === 'untitled' ? undefined : '  ',
                  description: 'Do not use this fallback',
                },
              ],
            ]);
      agorStore.setState({ sessionById: sessions });
      render(
        <MessageBlock
          message={message(`${block}\n\nship the branch`, { prompt_provenance: provenance })}
        />
      );
      expect(screen.getByText('Sent by another session')).toBeVisible();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Do not use this fallback|claude-code|01a0d369/)
      ).not.toBeInTheDocument();
    }
  );

  it('follows sender title changes in the existing session state', () => {
    render(<MessageBlock message={message(`${block}\n\nship the branch`)} />);
    act(() =>
      agorStore.setState({ sessionById: new Map([[origin, { ...sender, title: 'Updated plan' }]]) })
    );
    expect(screen.getByRole('link', { name: 'Open sender session' })).toHaveAttribute(
      'href',
      sessionPath(origin)
    );
    expect(screen.queryByText('Sent by Release planning')).not.toBeInTheDocument();
  });

  it('drops the title and link when the sender leaves the viewer session map', () => {
    render(<MessageBlock message={message(`${block}\n\nship the branch`)} />);
    expect(screen.getByRole('link', { name: 'Open sender session' })).toBeVisible();
    expect(screen.getByText('Sent by Release planning')).toBeVisible();
    act(() => agorStore.setState({ sessionById: new Map() }));
    expect(screen.getByText('Sent by another session')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it.each([
    ['structured', MessageRole.ASSISTANT],
    ['structured', MessageRole.USER],
    ['legacy', MessageRole.ASSISTANT],
    ['legacy', MessageRole.USER],
  ] as const)(
    'uses callback presentation for %s provenance (callback role: %s)',
    (kind, callbackRole) => {
      const stamped = message(
        `${block}\n\nship the branch`,
        kind === 'structured' ? { prompt_provenance: provenance } : undefined
      );
      const callback = {
        ...message('Callback body', { is_agor_callback: true }),
        role: callbackRole,
      };
      const { container } = render(
        <>
          <MessageBlock message={callback} />
          <MessageBlock message={stamped} />
        </>
      );
      const bubbles = container.querySelectorAll<HTMLElement>('.ant-bubble-content');
      const avatars = container.querySelectorAll<HTMLImageElement>('.ant-bubble-avatar img');
      expect(bubbles).toHaveLength(2);
      expect(bubbles[0]).toHaveClass('ant-bubble-content-filled');
      expect(bubbles[1]).toHaveClass('ant-bubble-content-filled');
      expect(bubbles[1].style.backgroundColor).toBe(bubbles[0].style.backgroundColor);
      expect(avatars).toHaveLength(2);
      expect(avatars[1].getAttribute('src')).toBe(avatars[0].getAttribute('src'));
      expect(avatars[1].getAttribute('alt')).toBe(avatars[0].getAttribute('alt'));
      expect(getMessageSpeaker(stamped)).toBe('agent');
      expect(getMessageSpeaker(message('Human body'))).toBe('user');
    }
  );

  it('links to the session under the mounted UI base path', () => {
    window.history.replaceState(null, '', '/ui/');
    try {
      render(<MessageBlock message={message(`${block}\n\nship the branch`)} />);
      expect(screen.getByRole('link', { name: 'Open sender session' })).toHaveAttribute(
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
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
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
    expect(screen.getByText('Sent by another session')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders an unattributed legacy stamp without claiming an origin', () => {
    const unattributed = renderPromptProvenanceBlock({
      userLabel: 'sender@example.invalid',
      authenticatedBy: 'personal_api_key',
      tool: 'agor_sessions_create',
    });
    render(<MessageBlock message={message(`${unattributed}\n\nship the branch`)} />);
    expect(screen.getByText('Sent by another session')).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(
      screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === unattributed)
    ).toBeVisible();
  });

  it.each([
    'ordinary message',
    'quoted &lt;agor_prompt_provenance&gt;not a stamp&lt;/agor_prompt_provenance&gt;',
  ])('leaves unstamped text unchanged: %s', (text) => {
    const unstamped = message(text);
    const { container } = render(<MessageBlock message={unstamped} />);
    expect(getMessageSpeaker(unstamped)).toBe('user');
    expect(container.querySelector('.ant-bubble-avatar img')).toBeNull();
    expect(screen.queryByRole('button', { name: /Details/ })).not.toBeInTheDocument();
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
