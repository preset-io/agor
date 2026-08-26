import type { Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SessionPage } from './SessionPage';

vi.mock('../ConversationView', () => ({
  ConversationView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="conversation-session">{sessionId}</div>
  ),
}));

vi.mock('./MobileHeader', () => ({
  MobileHeader: ({ actions }: { actions?: ReactNode }) => (
    <header>
      Session
      {actions}
    </header>
  ),
}));

vi.mock('./MobilePromptInput', () => ({
  MobilePromptInput: ({
    onSend,
    sessionId,
  }: {
    onSend: (prompt: string) => unknown;
    sessionId: string;
  }) => (
    <div>
      <span data-testid="composer-session">{sessionId}</span>
      <button type="button" onClick={() => onSend('hello')}>
        Send
      </button>
    </div>
  ),
}));

describe('SessionPage', () => {
  it('uses the resolved full session id for cold short-token actions and drafts', () => {
    const sessionId = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
    const shortToken = '01a012d84f507c329daa6e3f';
    const branchId = '01a012d8-3e4f-7b21-8c99-5d2e6f708a1b';
    const onSendPrompt = vi.fn();

    render(
      <MemoryRouter initialEntries={[`/m/session/${shortToken}`]}>
        <Routes>
          <Route
            path="/m/session/:sessionId"
            element={
              <SessionPage
                client={null}
                sessionById={
                  new Map([
                    [
                      sessionId,
                      {
                        session_id: sessionId,
                        branch_id: branchId,
                        status: 'idle',
                      } as Session,
                    ],
                  ])
                }
                branchById={
                  new Map([[branchId, { branch_id: branchId, name: 'feat/mobile' } as Branch]])
                }
                repoById={new Map()}
                userById={new Map()}
                onSendPrompt={onSendPrompt}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('conversation-session')).toHaveTextContent(sessionId);
    expect(screen.getByTestId('composer-session')).toHaveTextContent(sessionId);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSendPrompt).toHaveBeenCalledWith(sessionId, 'hello');
  });

  it('offers the session-level chat collection action', () => {
    const sessionId = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
    const branchId = '01a012d8-3e4f-7b21-8c99-5d2e6f708a1b';
    const onPinToChatCollection = vi.fn();
    render(
      <MemoryRouter initialEntries={[`/m/session/${sessionId}`]}>
        <Routes>
          <Route
            path="/m/session/:sessionId"
            element={
              <SessionPage
                client={null}
                sessionById={
                  new Map([
                    [
                      sessionId,
                      {
                        session_id: sessionId,
                        branch_id: branchId,
                        status: 'idle',
                      } as Session,
                    ],
                  ])
                }
                branchById={
                  new Map([[branchId, { branch_id: branchId, name: 'feat/mobile' } as Branch]])
                }
                repoById={new Map()}
                userById={new Map()}
                onPinToChatCollection={onPinToChatCollection}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add to chat collection' }));
    expect(onPinToChatCollection).toHaveBeenCalledWith(sessionId);
  });
});
