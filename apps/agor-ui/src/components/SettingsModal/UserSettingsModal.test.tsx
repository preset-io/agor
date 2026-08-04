import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UserSettingsModal } from './UserSettingsModal';

vi.mock('../ApiKeyFields', () => ({
  ApiKeyFields: () => null,
  TOOL_FIELD_CONFIGS: {
    'claude-code': [],
    codex: [{ field: 'OPENAI_API_KEY', label: 'OpenAI API Key' }],
    gemini: [],
    opencode: [],
    copilot: [],
    cursor: [],
  },
}));

vi.mock('../AgenticToolConfigForm', async () => {
  const { Form, Radio } = await import('antd');

  const MockModelSelector = ({
    agenticTool,
    value,
    onChange,
  }: {
    agenticTool: AgenticToolName;
    value?: { model?: string };
    onChange?: (value: { mode: 'alias'; model: string }) => void;
  }) => (
    <Radio.Group
      value={value?.model}
      onChange={(event) => onChange?.({ mode: 'alias', model: event.target.value })}
    >
      <Radio value="claude-sonnet-5">{agenticTool} model claude-sonnet-5</Radio>
      <Radio value="claude-opus-4-8">{agenticTool} model claude-opus-4-8</Radio>
    </Radio.Group>
  );

  return {
    AgenticToolConfigForm: ({ agenticTool }: { agenticTool: AgenticToolName }) => (
      <>
        <Form.Item name="permissionMode" label="Permission Mode">
          <Radio.Group>
            <Radio value="default">{agenticTool} default</Radio>
            <Radio value="acceptEdits">{agenticTool} acceptEdits</Radio>
            <Radio value="ask">{agenticTool} ask</Radio>
            <Radio value="allow-all">{agenticTool} allow-all</Radio>
          </Radio.Group>
        </Form.Item>
        {/* Stand-in for ModelSelector so tests can assert the saved modelConfig alias. */}
        <Form.Item name="modelConfig" label="Model">
          <MockModelSelector agenticTool={agenticTool} />
        </Form.Item>
      </>
    ),
    buildConfigFromFormValues: (
      _tool: AgenticToolName,
      values: {
        permissionMode?: string;
        modelConfig?: { mode?: string; model?: string };
      }
    ) => ({
      permissionMode: values.permissionMode,
      ...(values.modelConfig ? { modelConfig: values.modelConfig } : {}),
    }),
    getClearedFormValues: () => ({ permissionMode: 'default' }),
    getFormValuesFromConfig: (
      _tool: AgenticToolName,
      config?: {
        permissionMode?: string;
        modelConfig?: { mode?: string; model?: string };
      }
    ) => ({
      permissionMode: config?.permissionMode ?? 'default',
      modelConfig: config?.modelConfig,
    }),
  };
});

function renderWithApp(children: ReactNode) {
  return render(<AntApp>{children}</AntApp>);
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'admin@agor.live',
    name: 'Admin',
    role: 'member',
    default_agentic_config: {},
    ...overrides,
  } as User;
}

// This renders the full settings modal plus Ant Form/Menu/Modal plumbing so we
// can prove dirty defaults survive real tab switches. That is intentionally
// heavier than a pure unit test and can exceed Vitest's 15s package default on
// the GitHub runner when the full UI suite is running in parallel.
const ASYNC = { timeout: 10_000 };

describe('UserSettingsModal', { timeout: 60_000 }, () => {
  it('saves dirty agentic defaults across tabs and closes from the footer', async () => {
    const user = makeUser({
      default_agentic_config: {
        'claude-code': { permissionMode: 'default' },
        codex: { permissionMode: 'ask' },
      },
    });
    const onUpdate = vi.fn();
    const onClose = vi.fn();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /claude code/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('claude-code default')).toBeChecked();
    }, ASYNC);
    fireEvent.click(screen.getByLabelText('claude-code acceptEdits'));

    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }));
    await screen.findByRole('heading', { name: 'Codex' });
    fireEvent.click(screen.getByText('Session Defaults'));
    fireEvent.click(screen.getByLabelText('codex allow-all'));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('user-1', {
        default_agentic_config: {
          'claude-code': { permissionMode: 'acceptEdits' },
          codex: { permissionMode: 'allow-all' },
        },
        default_agentic_selection: {
          'claude-code': { source: 'inline' },
          codex: { source: 'inline' },
        },
        default_mcp_server_ids: [],
      });
    }, ASYNC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without rewriting OpenCode defaults when provider settings are unchanged', async () => {
    const user = makeUser({
      default_agentic_config: {
        opencode: {
          permissionMode: 'yolo',
          modelConfig: { mode: 'exact', provider: 'kimi-for-coding', model: 'k3' },
        },
      },
      default_agentic_selection: {
        opencode: { source: 'inline' },
      },
    });
    const onUpdate = vi.fn();
    const onClose = vi.fn();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        client={null}
        onUpdate={onUpdate}
        initialTab="opencode"
      />
    );

    await screen.findByRole('heading', { name: 'OpenCode' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), ASYNC);
  });

  it('offers the three Codex authentication methods, defaulting to the sign-in view for a subscription', async () => {
    const user = makeUser({ agentic_auth_methods: { codex: 'subscription' } });
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }));
    await screen.findByRole('heading', { name: 'Codex' });
    // The method selector surfaces all three ways in.
    expect(screen.getByText('API key')).toBeInTheDocument();
    expect(screen.getByText('Sign in with ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('Import login file')).toBeInTheDocument();
    // A stored subscription lands on the ChatGPT sign-in view.
    expect(screen.getByText(/Sign in with your ChatGPT account/i)).toBeInTheDocument();
  });

  it('saves a Claude model alias before closing', async () => {
    // Stale `user` prop that never reflects the save — mirrors the realtime lag
    // between the resolved patch and the Feathers `patched` event that refreshes
    // the prop. Before the fix, clearing the draft after save re-ran hydration
    // against this stale config and snapped the field back to sonnet-5.
    const user = makeUser({
      default_agentic_config: {
        'claude-code': {
          permissionMode: 'default',
          modelConfig: { mode: 'alias', model: 'claude-sonnet-5' },
        },
      },
    });
    const onUpdate = vi.fn(async () => {});
    const onClose = vi.fn();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /claude code/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('claude-code model claude-sonnet-5')).toBeChecked();
    }, ASYNC);

    fireEvent.click(screen.getByLabelText('claude-code model claude-opus-4-8'));
    expect(screen.getByLabelText('claude-code model claude-opus-4-8')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('user-1', {
        default_agentic_config: {
          'claude-code': {
            permissionMode: 'default',
            modelConfig: { mode: 'alias', model: 'claude-opus-4-8' },
          },
        },
        default_agentic_selection: {
          'claude-code': { source: 'inline' },
        },
        default_mcp_server_ids: [],
      });
    }, ASYNC);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves General settings and closes from the footer', async () => {
    const user = makeUser();
    const onUpdate = vi.fn(async () => {});
    const onClose = vi.fn();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    const passwordInput = screen.getByPlaceholderText('••••••••') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'new-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ password: 'new-password' })
      );
    }, ASYNC);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the modal open when saving General settings fails', async () => {
    const user = makeUser();
    const onUpdate = vi.fn(async () => {
      throw new Error('save failed');
    });
    const onClose = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithApp(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    }, ASYNC);
    expect(onClose).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('keeps the modal open when saving Audio settings fails', async () => {
    const user = makeUser();
    const onUpdate = vi.fn(async () => {
      throw new Error('save failed');
    });
    const onClose = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithApp(
      <UserSettingsModal
        open
        onClose={onClose}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /audio/i }));
    await screen.findByRole('heading', { name: 'Audio' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    }, ASYNC);
    expect(onClose).not.toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('keeps the Env Vars section selected after saving and receiving updated user props', async () => {
    const initialUser = makeUser({
      env_vars: {
        Z_TOKEN: { set: true, scope: 'global', resource_id: null },
      },
    });
    const onClose = vi.fn();
    const updateSpy = vi.fn();

    function Harness() {
      const [user, setUser] = useState(initialUser);
      return (
        <UserSettingsModal
          open
          onClose={onClose}
          user={user}
          currentUser={user}
          client={null as AgorClient | null}
          onUpdate={async (userId, updates) => {
            updateSpy(userId, updates);
            if (updates.env_vars) {
              setUser((prev) => ({
                ...prev,
                env_vars: {
                  ...(prev.env_vars ?? {}),
                  ...Object.fromEntries(
                    Object.entries(updates.env_vars ?? {}).flatMap(([key, value]) =>
                      value === null
                        ? []
                        : [
                            [
                              key,
                              {
                                set: true,
                                scope: updates.env_var_scopes?.[key] ?? 'global',
                                resource_id: null,
                              },
                            ],
                          ]
                    )
                  ),
                },
              }));
            }
          }}
        />
      );
    }

    renderWithApp(<Harness />);

    fireEvent.click(screen.getByRole('menuitem', { name: /env vars/i }));
    await screen.findByRole('heading', { name: 'Environment Variables' });

    fireEvent.change(screen.getByPlaceholderText(/variable name/i), {
      target: { value: 'ALPHA_TOKEN' },
    });
    fireEvent.change(screen.getByPlaceholderText('Value'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('user-1', {
        env_vars: { ALPHA_TOKEN: 'secret' },
        env_var_scopes: { ALPHA_TOKEN: 'global' },
      });
    }, ASYNC);

    expect(screen.getByRole('heading', { name: 'Environment Variables' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('resets OpenCode provider state when the authenticated subject changes', async () => {
    const oldSettings = {
      runtime: 'available' as const,
      runtimeVersion: '1.14.33',
      isolation: { mode: 'simple' as const, boundary: 'logical' as const },
      providers: [
        {
          id: 'old-provider',
          name: 'Old User Provider',
          runtimeAvailable: false,
          credentialPresence: 'absent' as const,
          authMethods: [
            { index: 0, type: 'api' as const, label: 'API key' },
            { index: 1, type: 'oauth' as const, label: 'Browser flow' },
          ],
        },
      ],
    };
    const newSettings = {
      ...oldSettings,
      providers: [
        {
          id: 'new-provider',
          name: 'New User Provider',
          runtimeAvailable: true,
          credentialPresence: 'present' as const,
          authMethods: [],
        },
      ],
    };
    const attempt = {
      attemptId: 'old-attempt',
      providerId: 'old-provider',
      phase: 'awaiting_callback' as const,
      expiresAt: '2026-07-24T00:00:00.000Z',
      authorization: {
        url: 'http://127.0.0.1:9898/authorize',
        method: 'auto' as const,
        instructions: 'Old user authorization.',
      },
    };
    const service = {
      find: vi.fn().mockResolvedValueOnce(oldSettings).mockResolvedValueOnce(newSettings),
      get: vi.fn(),
      create: vi.fn().mockResolvedValue(attempt),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    let authentication: unknown = { accessToken: 'old-subject' };
    const client = {
      service: vi.fn(() => service),
      get: vi.fn(() => authentication),
      on: vi.fn(),
    } as unknown as AgorClient;
    const oldUser = makeUser();
    const newUser = makeUser({
      user_id: 'user-2',
      email: 'new-user@agor.live',
      name: 'New User',
    });
    const renderModal = (subject: User) => (
      <AntApp>
        <UserSettingsModal
          open
          onClose={vi.fn()}
          user={subject}
          currentUser={subject}
          client={client}
          onUpdate={vi.fn()}
          initialTab="opencode"
        />
      </AntApp>
    );
    const { rerender } = render(renderModal(oldUser));

    fireEvent.change(await screen.findByLabelText('Old User Provider API key'), {
      target: { value: 'old-user-secret' },
    });
    fireEvent.mouseDown(
      screen.getByRole('combobox', { name: 'Old User Provider authentication method' })
    );
    fireEvent.click(await screen.findByText('Browser flow'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect with Browser flow' }));
    expect(await screen.findByText('Old user authorization.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel authorization' })).toBeInTheDocument();

    authentication = { accessToken: 'new-subject' };
    rerender(renderModal(newUser));

    expect(await screen.findByText('New User Provider')).toBeInTheDocument();
    expect(screen.getByText('Available in runtime')).toBeInTheDocument();
    expect(screen.getByText('Saved credential')).toBeInTheDocument();
    expect(screen.queryByLabelText('Old User Provider API key')).not.toBeInTheDocument();
    expect(screen.queryByText('Old user authorization.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel authorization' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('old-user-secret');
    expect(service.find).toHaveBeenCalledTimes(2);
  });

  it('ignores a delayed OpenCode settings response from the previous subject', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const newSettings = {
      runtime: 'available' as const,
      runtimeVersion: '1.14.33',
      isolation: { mode: 'simple' as const, boundary: 'logical' as const },
      providers: [
        {
          id: 'new-provider',
          name: 'New User Provider',
          runtimeAvailable: true,
          credentialPresence: 'present' as const,
          authMethods: [],
        },
      ],
    };
    const oldSettings = {
      ...newSettings,
      providers: [
        {
          id: 'old-provider',
          name: 'Delayed Old Provider',
          runtimeAvailable: true,
          credentialPresence: 'present' as const,
          authMethods: [],
        },
      ],
    };
    const service = {
      find: vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(newSettings),
      get: vi.fn(),
      create: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
    };
    let authentication: unknown = { accessToken: 'old-subject' };
    const client = {
      service: vi.fn(() => service),
      get: vi.fn(() => authentication),
      on: vi.fn(),
    } as unknown as AgorClient;
    const oldUser = makeUser();
    const newUser = makeUser({
      user_id: 'user-2',
      email: 'new-user@agor.live',
      name: 'New User',
    });
    const renderModal = (subject: User) => (
      <AntApp>
        <UserSettingsModal
          open
          onClose={vi.fn()}
          user={subject}
          currentUser={subject}
          client={client}
          onUpdate={vi.fn()}
          initialTab="opencode"
        />
      </AntApp>
    );
    const { rerender } = render(renderModal(oldUser));

    await waitFor(() => expect(service.find).toHaveBeenCalledTimes(1));
    authentication = { accessToken: 'new-subject' };
    rerender(renderModal(newUser));

    expect(await screen.findByText('New User Provider')).toBeInTheDocument();
    await act(async () => {
      resolveOld(oldSettings);
      await Promise.resolve();
    });

    expect(screen.getByText('New User Provider')).toBeInTheDocument();
    expect(screen.queryByText('Delayed Old Provider')).not.toBeInTheDocument();
  });
});
