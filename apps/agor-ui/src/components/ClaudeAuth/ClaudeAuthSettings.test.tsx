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
import { ClaudeOAuthSignIn } from './ClaudeOAuthSignIn';

const UNKNOWN: AuthCheckResult = { status: 'unknown', authenticated: false, method: 'none' };

interface HarnessOptions {
  initialMethod?: AgenticAuthMethod;
  fieldStatus?: Record<string, boolean>;
  checkAuth?: ReturnType<typeof vi.fn>;
  logoutCreate?: ReturnType<typeof vi.fn>;
  onSaveField?: ReturnType<typeof vi.fn>;
  onClearField?: ReturnType<typeof vi.fn>;
  allowSubscriptionLogin?: boolean;
}

function Harness({
  initialMethod = 'api_key',
  fieldStatus = {},
  checkAuth,
  logoutCreate,
  onSaveField,
  onClearField,
  allowSubscriptionLogin = true,
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
      allowSubscriptionLogin={allowSubscriptionLogin}
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

  it('lets an admin manage a pasted subscription token without exposing caller-bound OAuth', async () => {
    render(<Harness initialMethod="subscription" allowSubscriptionLogin={false} />);
    expect(await screen.findByPlaceholderText('sk-ant-oat01-...')).toBeInTheDocument();
    expect(screen.getByText('Subscription token')).toBeInTheDocument();
    expect(screen.queryByText('Sign in with Claude')).not.toBeInTheDocument();
  });
});

describe('ClaudeOAuthSignIn', () => {
  it('adopts an exchanging attempt without replacing it on remount', async () => {
    const onVerified = vi.fn();
    const oauth = {
      find: vi
        .fn()
        .mockResolvedValueOnce({ phase: 'exchanging' })
        .mockResolvedValueOnce({ phase: 'success' }),
      create: vi.fn(async () => ({ phase: 'awaiting_code' })),
    };
    const client = { service: vi.fn(() => oauth) } as never;
    render(<ClaudeOAuthSignIn client={client} onVerified={onVerified} autoStart />);
    await waitFor(() => expect(oauth.find).toHaveBeenCalledTimes(2));
    expect(oauth.create).not.toHaveBeenCalled();
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
  });

  it('clears a stale success state when the persisted subscription login is removed', async () => {
    const oauth = {
      find: vi.fn(async () => ({ phase: 'idle' })),
      create: vi.fn(async () => ({ phase: 'success', hint: 'Signed in with Claude.' })),
    };
    const client = { service: vi.fn(() => oauth) } as never;
    const onVerified = vi.fn();
    const { rerender } = render(
      <ClaudeOAuthSignIn
        client={client}
        connected={false}
        onVerified={onVerified}
        autoStart={false}
      />
    );
    fireEvent.click(await screen.findByText('Sign in with Claude'));
    expect(await screen.findByText('Signed in with Claude.')).toBeInTheDocument();

    rerender(
      <ClaudeOAuthSignIn client={client} connected onVerified={onVerified} autoStart={false} />
    );
    rerender(
      <ClaudeOAuthSignIn
        client={client}
        connected={false}
        onVerified={onVerified}
        autoStart={false}
      />
    );
    expect(await screen.findByText('Sign in with Claude')).toBeInTheDocument();
  });
});
