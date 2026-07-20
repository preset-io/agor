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
import { useState } from 'react';
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
  onAuthMethodChange?: ReturnType<typeof vi.fn>;
}

// A stateful host so onAuthMethodChange actually flips the persisted method,
// exactly as the real settings modal does — the pane's method/probe logic
// depends on that round-trip.
function Harness({
  initialMethod = 'api_key',
  fieldStatus = {},
  checkAuth,
  importCreate,
  deviceCreate,
  deviceFind,
  onSaveField,
  onClearField,
  onAuthMethodChange,
}: HarnessOptions) {
  const [method, setMethod] = useState<AgenticAuthMethod>(initialMethod);
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
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => services[name] ?? {}),
  } as never;

  return (
    <CodexAuthSettings
      client={client}
      authMethod={method}
      onAuthMethodChange={(next) => {
        onAuthMethodChange?.(next);
        setMethod(next);
      }}
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

  it('does not deactivate a working API key when merely opening a subscription sign-in view', async () => {
    // Selecting "Sign in with ChatGPT" / "Import login file" is a local view
    // choice — the daemon flips the method to subscription only on success.
    // Persisting it here would break a still-working API-key configuration.
    const onAuthMethodChange = vi.fn();
    render(<Harness initialMethod="api_key" onAuthMethodChange={onAuthMethodChange} />);

    clickText('Sign in with ChatGPT');
    expect(await screen.findByText(/Sign in with your ChatGPT account/i)).toBeInTheDocument();
    expect(onAuthMethodChange).not.toHaveBeenCalled();

    clickText('Import login file');
    expect(await screen.findByLabelText('Codex auth.json contents')).toBeInTheDocument();
    expect(onAuthMethodChange).not.toHaveBeenCalled();

    // Deliberately choosing the API-key method is the only selection that persists.
    clickText('API key');
    expect(onAuthMethodChange).not.toHaveBeenCalled(); // already api_key — no redundant write
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
