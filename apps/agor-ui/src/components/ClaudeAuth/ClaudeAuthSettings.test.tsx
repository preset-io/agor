/**
 * Tests for the Claude authentication management pane. Mirrors CodexAuthSettings:
 * selecting a tab is a pure view switch, the connection banner tracks the stored
 * method, and disconnect is offered only for a subscription login.
 *
 * Query style mirrors CodexAuthSettings.test.tsx — plain text/placeholder queries
 * with `.closest('button')`, never `getByRole` (antd + jsdom cssstyle crash).
 */

import type { AgenticAuthMethod, AuthCheckResult } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { ClaudeAuthSettings } from './ClaudeAuthSettings';

const UNKNOWN: AuthCheckResult = { status: 'unknown', authenticated: false, method: 'none' };

interface HarnessOptions {
  initialMethod?: AgenticAuthMethod;
  fieldStatus?: Record<string, boolean>;
  checkAuth?: ReturnType<typeof vi.fn>;
  logoutCreate?: ReturnType<typeof vi.fn>;
  onSaveField?: ReturnType<typeof vi.fn>;
  onClearField?: ReturnType<typeof vi.fn>;
}

function Harness({
  initialMethod = 'api_key',
  fieldStatus = {},
  checkAuth,
  logoutCreate,
  onSaveField,
  onClearField,
}: HarnessOptions) {
  const services: Record<string, unknown> = {
    'check-auth': { create: checkAuth ?? vi.fn(async () => UNKNOWN) },
    'claude-auth/oauth': {
      create: vi.fn(async () => ({ phase: 'idle' })),
      find: vi.fn(async () => ({ phase: 'idle' })),
    },
    'claude-auth/logout': {
      create: logoutCreate ?? vi.fn(async () => ({ status: 'removed' })),
    },
  };
  const clientRef = useRef<unknown>(undefined);
  if (clientRef.current === undefined) {
    clientRef.current = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => services[name] ?? {}),
    };
  }
  const client = clientRef.current as never;

  return (
    <ClaudeAuthSettings
      client={client}
      authMethod={initialMethod}
      apiKeyFields={TOOL_FIELD_CONFIGS['claude-code']}
      fieldStatus={fieldStatus}
      onSaveField={onSaveField ?? vi.fn(async () => undefined)}
      onClearField={onClearField ?? vi.fn(async () => undefined)}
      savingFields={{}}
    />
  );
}

function clickText(text: string | RegExp) {
  const el = screen.getByText(text);
  const clickable = el.closest('button') ?? el.closest('label') ?? el;
  fireEvent.click(clickable);
}

describe('ClaudeAuthSettings', () => {
  it('shows a Connected banner when the probe reports an authenticated API key', async () => {
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'authenticated',
        authenticated: true,
        method: 'api-key',
      })
    );
    render(<Harness initialMethod="api_key" checkAuth={checkAuth} />);

    expect(await screen.findByText('Claude is connected')).toBeInTheDocument();
    expect(screen.getByText('Your Anthropic API key is working.')).toBeInTheDocument();
    await waitFor(() =>
      expect(checkAuth).toHaveBeenCalledWith({ tool: 'claude-code', validateNative: true })
    );
  });

  it('surfaces a missing subscription login as a prominent "Login not found" error', async () => {
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'unauthenticated',
        authenticated: false,
        method: 'none',
      })
    );
    render(<Harness initialMethod="subscription" checkAuth={checkAuth} />);
    // Subscription is not auto-probed on mount.
    expect(checkAuth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Recheck connection'));
    expect(await screen.findByText('Login not found')).toBeInTheDocument();
  });

  it('switches methods as a pure view — no selection persists a credential', async () => {
    const onSaveField = vi.fn(async () => undefined);
    const onClearField = vi.fn(async () => undefined);
    render(
      <Harness initialMethod="api_key" onSaveField={onSaveField} onClearField={onClearField} />
    );

    clickText('Sign in with Claude');
    expect(await screen.findByText(/Sign in with your Claude subscription/i)).toBeInTheDocument();
    clickText('Subscription token');
    expect(await screen.findByPlaceholderText('sk-ant-oat01-...')).toBeInTheDocument();
    clickText('API key');
    expect(await screen.findByPlaceholderText('sk-ant-api03-...')).toBeInTheDocument();

    expect(onSaveField).not.toHaveBeenCalled();
    expect(onClearField).not.toHaveBeenCalled();
  });

  it('offers Disconnect only for a subscription login, not for API keys', async () => {
    const { rerender } = render(<Harness initialMethod="api_key" />);
    await waitFor(() => expect(screen.getByText('API key')).toBeInTheDocument());
    expect(screen.queryByText('Disconnect')).not.toBeInTheDocument();

    rerender(<Harness initialMethod="subscription" />);
    expect(await screen.findByText('Disconnect')).toBeInTheDocument();
  });

  it('disconnects via a confirm calling claude-auth/logout', async () => {
    const logoutCreate = vi.fn(async () => ({ status: 'removed' }));
    render(<Harness initialMethod="subscription" logoutCreate={logoutCreate} />);

    // The trigger link opens the confirm; the confirm's ok button shares the
    // "Disconnect" label, so open via the first and confirm via the last.
    const triggers = screen.getAllByText('Disconnect').map((el) => el.closest('button'));
    fireEvent.click(triggers[0] as HTMLButtonElement);
    expect(await screen.findByText(/your other devices stay signed in/i)).toBeInTheDocument();
    const afterOpen = screen.getAllByText('Disconnect').map((el) => el.closest('button'));
    fireEvent.click(afterOpen[afterOpen.length - 1] as HTMLButtonElement);
    await waitFor(() => expect(logoutCreate).toHaveBeenCalledWith({}));
  });

  it('after disconnect stays on the sign-in view (no jump to API key) and drops Disconnect', async () => {
    const { rerender } = render(<Harness initialMethod="subscription" />);
    // On a subscription login the oauth sign-in view is shown.
    expect(await screen.findByText(/Sign in with your Claude subscription/i)).toBeInTheDocument();

    // The daemon logout clears the method → the parent re-renders with api_key.
    rerender(<Harness initialMethod="api_key" />);

    // No jarring tab jump: still on the sign-in view, and Disconnect is gone.
    expect(await screen.findByText(/Sign in with your Claude subscription/i)).toBeInTheDocument();
    expect(screen.queryByText('Disconnect')).not.toBeInTheDocument();
  });
});
