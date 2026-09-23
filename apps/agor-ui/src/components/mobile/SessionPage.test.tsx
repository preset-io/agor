import type { Branch, Session } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { type AppActionsContextValue, useAppActions } from '../../contexts/AppActionsContext';
import { SessionPage } from './SessionPage';

// SessionPanel is the shared desktop composer; here we only assert that the
// mobile page resolves the route token to the canonical session and hands it
// the full session object (feature parity is SessionPanel's own contract).
const sessionPanelProps = vi.fn();
vi.mock('../SessionPanel', () => ({
  SessionPanel: (props: { session: Session; open: boolean }) => {
    sessionPanelProps(props);
    const actions = useAppActions();
    return (
      <div data-testid="session-panel">
        {props.session.session_id}
        <button type="button" onClick={() => actions.onOpenBranch?.('branch-1', 'environment')}>
          Open environment
        </button>
        <button type="button" onClick={() => actions.onOpenAgenticToolSettings?.('codex')}>
          Connect provider
        </button>
      </div>
    );
  },
}));

let settingsModalProps: Record<string, unknown> = {};
vi.mock('../SessionSettingsModal', () => ({
  SessionSettingsModal: (props: Record<string, unknown>) => {
    settingsModalProps = props;
    return null;
  },
}));

const noopAsync = vi.fn(async () => {});
const noop = vi.fn();

function renderAt(
  path: string,
  sessionById: Map<string, Session>,
  actions: Pick<AppActionsContextValue, 'onOpenBranch' | 'onOpenAgenticToolSettings'> &
    Pick<
      React.ComponentProps<typeof SessionPage>,
      'onUpdateSessionMcpServers' | 'onUpdateSessionEnvSelections'
    > = {}
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/m/session/:sessionId"
          element={
            <SessionPage
              client={null}
              sessionById={sessionById}
              branchById={new Map<string, Branch>()}
              boardById={new Map()}
              onSendPrompt={vi.fn()}
              onForkSession={noopAsync}
              onBtwForkSession={noopAsync}
              onSpawnSession={noopAsync}
              onUpdateSession={noop}
              onDeleteSession={noop}
              {...actions}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('SessionPage', () => {
  it('resolves a cold short token to the canonical session for SessionPanel', () => {
    const sessionId = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
    const shortToken = '01a012d84f507c329daa6e3f';
    sessionPanelProps.mockClear();

    renderAt(
      `/m/session/${shortToken}`,
      new Map([[sessionId, { session_id: sessionId, status: 'idle' } as Session]])
    );

    expect(screen.getByTestId('session-panel')).toHaveTextContent(sessionId);
    expect(sessionPanelProps).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ session_id: sessionId }),
        open: true,
      })
    );
  });

  it('preserves branch navigation and provider recovery callbacks in the mobile action context', () => {
    const onOpenBranch = vi.fn();
    const onOpenAgenticToolSettings = vi.fn();
    renderAt(
      '/m/session/session-1',
      new Map([['session-1', { session_id: 'session-1' } as Session]]),
      { onOpenBranch, onOpenAgenticToolSettings }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open environment' }));
    expect(onOpenBranch).toHaveBeenCalledWith('branch-1', 'environment');
    fireEvent.click(screen.getByRole('button', { name: 'Connect provider' }));
    expect(onOpenAgenticToolSettings).toHaveBeenCalledWith('codex');
  });

  it('hands the settings modal every save handler, so no edit is silently dropped', () => {
    const sessionId = '01a012d8-4f50-7c32-9daa-6e3f70819b2c';
    const session = { session_id: sessionId, branch_id: 'branch-1' } as Session;
    const handlers = { onUpdateSessionMcpServers: vi.fn(), onUpdateSessionEnvSelections: vi.fn() };
    renderAt(`/m/session/${sessionId}`, new Map([[sessionId, session]]), handlers);
    expect(settingsModalProps.onUpdate).toBe(noop);
    expect(settingsModalProps.onUpdateSessionMcpServers).toBe(handlers.onUpdateSessionMcpServers);
    expect(settingsModalProps.onUpdateSessionEnvSelections).toBe(
      handlers.onUpdateSessionEnvSelections
    );
  });

  it('shows a loading state until the session is in the store', () => {
    const { container } = renderAt('/m/session/unknown-token', new Map<string, Session>());
    expect(container.querySelector('.ant-spin')).not.toBeNull();
    expect(screen.queryByTestId('session-panel')).not.toBeInTheDocument();
  });
});
