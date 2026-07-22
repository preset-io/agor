/**
 * Tests for the Codex authentication management pane (settings surface).
 *
 * Unlike the onboarding wizard, this is a management view: it probes the live
 * connection, surfaces a stored-but-broken credential as a prominent error, and
 * keeps every sign-in path reachable while connected.
 *
 * Query style mirrors OnboardingWizard.test.tsx — plain text queries with
 * `.closest('button')`, never `getByRole`, because computing an accessible name
 * while an antd `Tag`/`Segmented` is mounted walks a CSS shorthand rule that
 * crashes jsdom's `cssstyle`.
 */

import type { AgenticAuthMethod, AuthCheckResult } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { CodexAuthSettings } from './CodexAuthSettings';

const UNKNOWN: AuthCheckResult = { status: 'unknown', authenticated: false, method: 'none' };

interface HarnessOptions {
  initialMethod?: AgenticAuthMethod;
  fieldStatus?: Record<string, boolean>;
  checkAuth?: ReturnType<typeof vi.fn>;
  importCreate?: ReturnType<typeof vi.fn>;
  deviceCreate?: ReturnType<typeof vi.fn>;
  deviceFind?: ReturnType<typeof vi.fn>;
  onSaveField?: ReturnType<typeof vi.fn>;
  onClearField?: ReturnType<typeof vi.fn>;
}

// The pane never mutates the persisted method itself — the method is a
// consequence of the credential the user configures (a key save / a completed
// device sign-in or import), which the real settings modal drives — so the
// harness holds authMethod fixed and asserts selection stays non-destructive.
function Harness({
  initialMethod = 'api_key',
  fieldStatus = {},
  checkAuth,
  importCreate,
  deviceCreate,
  deviceFind,
  onSaveField,
  onClearField,
}: HarnessOptions) {
  const services: Record<string, unknown> = {
    'check-auth': { create: checkAuth ?? vi.fn(async () => UNKNOWN) },
    'codex-auth/import': {
      create: importCreate ?? vi.fn(async () => ({ status: 'authenticated' })),
    },
    'codex-auth/device': {
      create: deviceCreate ?? vi.fn(async () => ({ phase: 'idle' })),
      find: deviceFind ?? vi.fn(async () => ({ phase: 'idle' })),
    },
  };
  // Stable client identity across rerenders (mirrors the real modal, where the
  // client outlives authMethod changes) — so a rerender that flips only
  // authMethod exercises the method-change path, not a client swap.
  const clientRef = useRef<unknown>(undefined);
  if (clientRef.current === undefined) {
    clientRef.current = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => services[name] ?? {}),
    };
  }
  const client = clientRef.current as never;

  return (
    <CodexAuthSettings
      client={client}
      authMethod={initialMethod}
      apiKeyFields={TOOL_FIELD_CONFIGS.codex}
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

describe('CodexAuthSettings', () => {
  it('shows a Connected banner when the probe reports an authenticated API key', async () => {
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'authenticated',
        authenticated: true,
        method: 'api-key',
      })
    );
    render(<Harness initialMethod="api_key" checkAuth={checkAuth} />);

    expect(await screen.findByText('Codex is connected')).toBeInTheDocument();
    expect(screen.getByText('Your OpenAI API key is working.')).toBeInTheDocument();
    await waitFor(() => expect(checkAuth).toHaveBeenCalledWith({ tool: 'codex' }));
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

    expect(await screen.findByText('Login not found')).toBeInTheDocument();
    expect(screen.getByText(/Codex login no longer found on this server/i)).toBeInTheDocument();
    expect(screen.queryByText('Key not working')).not.toBeInTheDocument();
  });

  it('flags a stored-but-rejected API key as "Key not working"', async () => {
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'unauthenticated',
        authenticated: false,
        method: 'api-key',
      })
    );
    render(
      <Harness
        initialMethod="api_key"
        fieldStatus={{ OPENAI_API_KEY: true }}
        checkAuth={checkAuth}
      />
    );

    expect(await screen.findByText('Key not working')).toBeInTheDocument();
    expect(screen.queryByText('Login not found')).not.toBeInTheDocument();
  });

  it('stays silent when no key is stored and the probe is negative (fail safe)', async () => {
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'unauthenticated',
        authenticated: false,
        method: 'none',
      })
    );
    render(<Harness initialMethod="api_key" fieldStatus={{}} checkAuth={checkAuth} />);

    // Give the probe a chance to resolve before asserting the banner is absent.
    await waitFor(() => expect(checkAuth).toHaveBeenCalled());
    expect(screen.queryByText('Key not working')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex is connected')).not.toBeInTheDocument();
  });

  it('never affirms a ChatGPT login while the effective method is api_key (banner tracks stored method)', async () => {
    // Mixed state: method=api_key (keyless) with a login the probe can see. The
    // executor won't use that login for api_key, so the banner must not claim
    // "connected" — the sessions-broken-but-banner-connected contradiction.
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'authenticated',
        authenticated: true,
        method: 'native',
      })
    );
    render(<Harness initialMethod="api_key" fieldStatus={{}} checkAuth={checkAuth} />);

    await waitFor(() => expect(checkAuth).toHaveBeenCalled());
    expect(screen.queryByText('Codex is connected')).not.toBeInTheDocument();
    expect(screen.queryByText('A ChatGPT login is active on this server.')).not.toBeInTheDocument();
  });

  it('drops a stale negative verdict when the method flips (no false "Login not found")', async () => {
    // An api-key probe rejects; then the method flips to subscription, as a
    // completed ChatGPT sign-in would. The stale api-key rejection must not be
    // reinterpreted as a subscription failure — even while the re-probe for the
    // new method is still in flight (and would persist if that re-probe failed).
    let releaseSecond: (v: AuthCheckResult) => void = () => {};
    const checkAuth = vi
      .fn<[], Promise<AuthCheckResult>>()
      .mockResolvedValueOnce({ status: 'unauthenticated', authenticated: false, method: 'api-key' })
      .mockImplementationOnce(
        () =>
          new Promise<AuthCheckResult>((resolve) => {
            releaseSecond = resolve;
          })
      );
    const { rerender } = render(
      <Harness
        initialMethod="api_key"
        fieldStatus={{ OPENAI_API_KEY: true }}
        checkAuth={checkAuth}
      />
    );
    expect(await screen.findByText('Key not working')).toBeInTheDocument();

    // Flip to subscription; the second probe is in flight and unresolved.
    rerender(
      <Harness
        initialMethod="subscription"
        fieldStatus={{ OPENAI_API_KEY: true }}
        checkAuth={checkAuth}
      />
    );
    await waitFor(() => expect(checkAuth).toHaveBeenCalledTimes(2));
    // Neither the stale api-key rejection nor a subscription failure is shown.
    expect(screen.queryByText('Login not found')).not.toBeInTheDocument();
    expect(screen.queryByText('Key not working')).not.toBeInTheDocument();

    // Once the new probe resolves under the new method, the correct verdict shows.
    releaseSecond({ status: 'unauthenticated', authenticated: false, method: 'none' });
    expect(await screen.findByText('Login not found')).toBeInTheDocument();
  });

  it('saves an OpenAI API key through the API-key pane', async () => {
    const onSaveField = vi.fn(async () => undefined);
    render(<Harness initialMethod="api_key" onSaveField={onSaveField} />);

    const input = screen.getByPlaceholderText('sk-proj-...');
    fireEvent.change(input, { target: { value: 'sk-proj-abc123' } });
    // Two "Save" buttons render (key + base URL); the key field is first.
    const saveButtons = screen.getAllByText('Save').map((el) => el.closest('button'));
    fireEvent.click(saveButtons[0] as HTMLButtonElement);

    await waitFor(() =>
      expect(onSaveField).toHaveBeenCalledWith('OPENAI_API_KEY', 'sk-proj-abc123')
    );
  });

  it('starts the device flow deliberately (no OpenAI request on mere tab view)', async () => {
    const deviceFind = vi.fn(async () => ({ phase: 'idle' }));
    const deviceCreate = vi.fn(async () => ({
      phase: 'pending',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }));
    render(
      <Harness initialMethod="subscription" deviceFind={deviceFind} deviceCreate={deviceCreate} />
    );

    clickText('Sign in with ChatGPT');

    // Deliberate-start: a code is only requested after an explicit click.
    expect(await screen.findByText('Get a sign-in code')).toBeInTheDocument();
    expect(deviceCreate).not.toHaveBeenCalled();

    clickText('Get a sign-in code');
    await waitFor(() => expect(deviceCreate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
  });

  it('switches methods as a pure view — no selection persists a credential', async () => {
    // Selecting a tab is never destructive: the method follows the credential
    // you configure, so no key-save/clear is triggered by mere navigation.
    const onSaveField = vi.fn(async () => undefined);
    const onClearField = vi.fn(async () => undefined);
    render(
      <Harness initialMethod="api_key" onSaveField={onSaveField} onClearField={onClearField} />
    );

    clickText('Sign in with ChatGPT');
    expect(await screen.findByText(/Sign in with your ChatGPT account/i)).toBeInTheDocument();
    clickText('Import login file');
    expect(await screen.findByLabelText('Codex auth.json contents')).toBeInTheDocument();
    clickText('API key');
    expect(await screen.findByPlaceholderText('sk-proj-...')).toBeInTheDocument();

    expect(onSaveField).not.toHaveBeenCalled();
    expect(onClearField).not.toHaveBeenCalled();
  });

  it('opening the API-key tab from a subscription login is non-destructive (no silent break)', async () => {
    // Regression guard: a user with a working ChatGPT login who clicks "API key"
    // to look at the fields must not have their login deactivated. The pane
    // exposes no method-flip callback, and selection triggers no persistence.
    const onSaveField = vi.fn(async () => undefined);
    const checkAuth = vi.fn(
      async (): Promise<AuthCheckResult> => ({
        status: 'authenticated',
        authenticated: true,
        method: 'native',
      })
    );
    render(
      <Harness initialMethod="subscription" checkAuth={checkAuth} onSaveField={onSaveField} />
    );

    expect(await screen.findByText('Codex is connected')).toBeInTheDocument();
    expect(screen.getByText('A ChatGPT login is active on this server.')).toBeInTheDocument();

    clickText('API key');
    expect(await screen.findByPlaceholderText('sk-proj-...')).toBeInTheDocument();
    // The login banner is unaffected — nothing was persisted or re-probed away.
    expect(screen.getByText('Codex is connected')).toBeInTheDocument();
    expect(onSaveField).not.toHaveBeenCalled();
  });

  it('does not adopt a stale success in settings — re-signing-in stays reachable', async () => {
    // A device sign-in that succeeded within the daemon's adopt-TTL must not
    // wall off the management surface: the deliberate-start button remains.
    const deviceFind = vi.fn(async () => ({ phase: 'success', hint: 'Signed in with ChatGPT.' }));
    const deviceCreate = vi.fn(async () => ({
      phase: 'pending',
      userCode: 'WXYZ-9876',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }));
    render(
      <Harness initialMethod="subscription" deviceFind={deviceFind} deviceCreate={deviceCreate} />
    );

    clickText('Sign in with ChatGPT');
    // Success is not adopted (autoStart=false) — the restart button shows instead.
    expect(await screen.findByText('Get a sign-in code')).toBeInTheDocument();
    expect(screen.queryByText('Signed in with ChatGPT.')).not.toBeInTheDocument();

    clickText('Get a sign-in code');
    await waitFor(() => expect(deviceCreate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('WXYZ-9876')).toBeInTheDocument();
  });

  it('imports a pasted login file and re-probes the connection', async () => {
    const importCreate = vi.fn(async () => ({ status: 'authenticated', authMode: 'chatgpt' }));
    const checkAuth = vi
      .fn<[], Promise<AuthCheckResult>>()
      .mockResolvedValueOnce(UNKNOWN)
      .mockResolvedValue({ status: 'authenticated', authenticated: true, method: 'native' });
    render(
      <Harness initialMethod="subscription" importCreate={importCreate} checkAuth={checkAuth} />
    );

    clickText('Import login file');
    const pasted = '{"tokens":{"refresh_token":"r"}}';
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: pasted },
    });
    clickText('Import login');

    await waitFor(() => expect(importCreate).toHaveBeenCalledWith({ authJson: pasted }));
    // onImported triggers a fresh probe, which now reports connected.
    expect(await screen.findByText('Codex is connected')).toBeInTheDocument();
  });

  it('shows the daemon rejection message when an imported login file is invalid', async () => {
    const importCreate = vi.fn(async () => {
      throw new Error('This file has no ChatGPT login tokens and no API key.');
    });
    render(<Harness initialMethod="subscription" importCreate={importCreate} />);

    clickText('Import login file');
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: '{"tokens":{}}' },
    });
    clickText('Import login');

    expect(
      await screen.findByText(/This file has no ChatGPT login tokens and no API key\./)
    ).toBeInTheDocument();
  });
});
