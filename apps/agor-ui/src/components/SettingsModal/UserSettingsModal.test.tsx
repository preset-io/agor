import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider, type FormInstance, Grid } from 'antd';
import { type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { UserSettingsModal } from './UserSettingsModal';

const { syncGroupsForUser } = vi.hoisted(() => ({ syncGroupsForUser: vi.fn() }));
vi.mock('./groupMembershipSync', () => ({ syncGroupsForUser }));

vi.mock('../ApiKeyFields', () => ({
  ApiKeyFields: () => null,
  TOOL_FIELD_CONFIGS: {
    'claude-code': [],
    codex: [{ field: 'OPENAI_API_KEY', label: 'OpenAI API Key' }],
    // A second provider with an Authentication pane, so tests can prove a
    // sub-tab from one provider's search hit doesn't leak onto another.
    gemini: [{ field: 'GEMINI_API_KEY', label: 'Gemini API Key' }],
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

  // Mirror the real rendered model/provider labels so the search index (which
  // derives provider entries from this) stays findable in tests.
  const MODEL_LABELS: Record<string, string> = {
    codex: 'Codex Model',
    gemini: 'Gemini Model',
    opencode: 'OpenCode LLM Provider',
    copilot: 'Copilot Model',
    cursor: 'Cursor Model',
  };

  return {
    modelLabelForTool: (tool: string) => MODEL_LABELS[tool] ?? 'Claude Model',
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

// The MCP field is user-level but lives inside each provider form. Stand it in
// with a Form-connected control so clicking it fires the form's onValuesChange
// (how the real Select drives dirty-tracking + the mcp-edit-source tracking).
vi.mock('../MCPServerSelect', async () => {
  const { Form } = await import('antd');
  const McpControl = ({ onChange }: { value?: string[]; onChange?: (v: string[]) => void }) => (
    <button type="button" onClick={() => onChange?.(['mcp-picked'])}>
      pick-mcp
    </button>
  );
  return {
    SessionMcpServersField: () => (
      <Form.Item name="mcpServerIds" label="MCP servers">
        <McpControl />
      </Form.Item>
    ),
  };
});

// The real AudioSettingsTab renders an AntD Slider whose CSS-var `border`
// shorthand crashes jsdom's cssstyle normaliser on re-render. This faithful
// stand-in drives the SAME shared audio form (the `enabled` field the parent
// hydrates and saves), so the parent's audio draft-preservation logic is
// exercised without the environment crash.
vi.mock('./AudioSettingsTab', async () => {
  const { Form } = await import('antd');
  // A plain checkbox (no AntD Wave/border rules) avoids the cssstyle crash while
  // still binding to the shared audio form's `enabled` field.
  return {
    AudioSettingsTab: ({
      form,
      onValuesChange,
    }: {
      form: FormInstance;
      onValuesChange?: () => void;
    }) => (
      <Form form={form} onValuesChange={onValuesChange}>
        <Form.Item name="enabled" valuePropName="checked">
          <input type="checkbox" aria-label="Enable chimes" />
        </Form.Item>
      </Form>
    ),
  };
});

function renderWithApp(children: ReactNode) {
  // `hashed: false` drops AntD's per-class CSS-in-JS hash, which is the dominant
  // cost of mounting this Form/Menu/Modal-heavy tree in jsdom (seconds per
  // render otherwise). It only removes the `css-dev-only-*` hash suffix —
  // semantic `.ant-*` classes and all component behaviour are unchanged — so it
  // keeps these integration tests within the CI per-test timeout without
  // altering what they exercise.
  return render(
    <ConfigProvider theme={{ hashed: false }}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
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
  it('keeps deferred resume distinct from destructive restart', async () => {
    const onReopenOnboarding = vi.fn(async () => undefined);
    const user = makeUser({
      onboarding_completed: false,
      preferences: {
        onboarding: {
          boardId: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
          deferredAt: '2026-08-29T12:00:00.000Z',
        },
      },
    });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null}
        onUpdate={vi.fn()}
        onReopenOnboarding={onReopenOnboarding}
      />
    );

    expect(screen.getByRole('button', { name: 'Resume onboarding' })).toBeInTheDocument();
    expect(screen.getByText(/from your saved progress/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart from beginning' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume onboarding' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() =>
      expect(onReopenOnboarding).toHaveBeenCalledWith('resume', expect.any(Function))
    );
  });

  it('offers a from-scratch restart when onboarding is not deferred', () => {
    const user = makeUser({ onboarding_completed: true });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null}
        onUpdate={vi.fn()}
        onReopenOnboarding={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Restart onboarding' })).toBeInTheDocument();
    expect(screen.getByText(/from the beginning/i)).toBeInTheDocument();
  });

  it('fails closed when an admin opens a superadmin settings modal', () => {
    const currentAdmin = makeUser({
      user_id: 'admin-1',
      email: 'admin@example.test',
      role: 'admin',
    });
    const targetSuperadmin = makeUser({
      user_id: 'superadmin-1',
      email: 'superadmin@example.test',
      role: 'superadmin',
    });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={targetSuperadmin}
        currentUser={currentAdmin}
        client={null}
        onUpdate={vi.fn()}
        initialTab="security"
      />
    );

    expect(screen.getByRole('menuitem', { name: /profile/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /security/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /codex/i })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('John Doe')).toBeDisabled();
    expect(screen.getByPlaceholderText('user@example.com')).toBeDisabled();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('lets a superadmin manage an admin while locking self role changes', () => {
    const currentSuperadmin = makeUser({
      user_id: 'superadmin-1',
      email: 'superadmin@example.test',
      role: 'superadmin',
    });
    const targetAdmin = makeUser({
      user_id: 'admin-1',
      email: 'admin@example.test',
      role: 'admin',
    });
    const { unmount } = renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={targetAdmin}
        currentUser={currentSuperadmin}
        client={null}
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByRole('menuitem', { name: /security/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toBeEnabled();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();

    unmount();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={currentSuperadmin}
        currentUser={currentSuperadmin}
        client={null}
        onUpdate={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Role')).toBeDisabled();
  });

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

    fireEvent.click(screen.getByRole('menuitem', { name: /^claude code/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('claude-code default')).toBeChecked();
    }, ASYNC);
    fireEvent.click(screen.getByLabelText('claude-code acceptEdits'));

    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }));
    await screen.findByRole('heading', { name: 'Codex' });
    fireEvent.click(screen.getByText('Session defaults'));
    fireEvent.click(screen.getByLabelText('codex allow-all'));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'user-1',
        {
          default_agentic_config: {
            'claude-code': { permissionMode: 'acceptEdits' },
            codex: { permissionMode: 'allow-all' },
          },
          default_agentic_selection: {
            'claude-code': { source: 'inline' },
            codex: { source: 'inline' },
          },
          default_mcp_server_ids: [],
        },
        expect.any(Function)
      );
    }, ASYNC);
    expect(onClose).toHaveBeenCalledTimes(1);
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

  it.each([
    [
      'an explicit none source with a dormant API key',
      {
        agentic_auth_methods: { 'claude-code': 'api_key' as const },
        agentic_credential_sources: { 'claude-code': 'none' as const },
        agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      },
    ],
    [
      'a legacy empty subscription marker',
      { agentic_auth_methods: { 'claude-code': 'subscription' as const } },
    ],
  ])('shows Claude as disconnected for %s', async (_case, overrides) => {
    const user = makeUser(overrides);
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

    const claudeItem = screen.getByRole('menuitem', { name: /^claude code/i });
    expect(claudeItem).toHaveTextContent('Not connected');
  });

  it('shows an explicit managed-file Claude source as connected without a stored env token', () => {
    const user = makeUser({
      agentic_auth_methods: { 'claude-code': 'subscription' },
      agentic_credential_sources: { 'claude-code': 'managed_file' },
    });
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

    expect(screen.getByRole('menuitem', { name: /^claude code/i })).toHaveTextContent('Connected');
  });

  it('shows a legacy API-method row as connected when both credential families are stored', () => {
    const user = makeUser({
      agentic_auth_methods: { 'claude-code': 'api_key' },
      agentic_tools: {
        'claude-code': { ANTHROPIC_API_KEY: true, CLAUDE_CODE_OAUTH_TOKEN: true },
      },
    });
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

    expect(screen.getByRole('menuitem', { name: /^claude code/i })).toHaveTextContent('Connected');
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

    fireEvent.click(screen.getByRole('menuitem', { name: /^claude code/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('claude-code model claude-sonnet-5')).toBeChecked();
    }, ASYNC);

    fireEvent.click(screen.getByLabelText('claude-code model claude-opus-4-8'));
    expect(screen.getByLabelText('claude-code model claude-opus-4-8')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'user-1',
        {
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
        },
        expect.any(Function)
      );
    }, ASYNC);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves a new password from the Security panel and closes from the footer', async () => {
    const user = makeUser({ role: 'member', unix_username: 'member-home' });
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

    fireEvent.click(screen.getByRole('menuitem', { name: /security/i }));
    await screen.findByRole('heading', { name: 'Security' });

    const passwordInput = screen.getByPlaceholderText('••••••••') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'new-secure-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ password: 'new-secure-password' }),
        expect.any(Function)
      );
    }, ASYNC);

    const [, updates] = onUpdate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    // This is a dirty Security-panel save, not a Profile-only false positive:
    // the stored admin-owned field is present in the form but must not cross
    // the self-edit request boundary for a member.
    expect(updates).not.toHaveProperty('unix_username');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps externally managed identity read-only while saving Agor preferences', async () => {
    __resetAuthConfigForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          auth: {
            requireAuth: true,
            identity: {
              contractVersion: 1,
              userLifecycle: 'external',
              roleAuthority: 'claims',
              localAuth: 'disabled',
              external: { provider: 'external_launch', provisioning: 'jit' },
              capabilities: {
                users: {
                  create: false,
                  delete: false,
                  identityWrite: false,
                  roleWrite: false,
                  passwordWrite: false,
                  avatarSettingsWrite: false,
                  selfConfigurationWrite: true,
                },
              },
            },
          },
        }),
      })
    );
    const user = makeUser({ role: 'admin' });
    const onUpdate = vi.fn(async () => {});

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null}
        onUpdate={onUpdate}
      />
    );

    await screen.findByText('Identity and role are managed by your workspace');
    expect(screen.getByPlaceholderText('John Doe')).toBeDisabled();
    expect(screen.getByPlaceholderText('user@example.com')).toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: /security/i })).not.toBeInTheDocument();
    const useSlackAvatar = screen.getByRole('switch');
    expect(useSlackAvatar).toBeEnabled();
    fireEvent.click(useSlackAvatar);

    fireEvent.click(screen.getByRole('menuitem', { name: /preferences/i }));
    await screen.findByRole('heading', { name: 'Preferences' });
    const enableChimes = document.querySelector<HTMLInputElement>(
      'input[aria-label="Enable chimes"]'
    );
    expect(enableChimes).not.toBeNull();
    fireEvent.click(enableChimes as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled(), ASYNC);
    const patch = onUpdate.mock.calls[0][1];
    expect(patch.preferences?.audio?.enabled).toBe(true);
    expect(patch.preferences?.use_slack_avatar).toBe(false);
    expect(patch).not.toHaveProperty('email');
    expect(patch).not.toHaveProperty('name');
    expect(patch).not.toHaveProperty('role');
    expect(patch).not.toHaveProperty('password');
  });

  it('keeps the modal open when saving Profile settings fails', async () => {
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

  it('keeps the modal open when saving Preferences settings fails', async () => {
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

    fireEvent.click(screen.getByRole('menuitem', { name: /preferences/i }));
    await screen.findByRole('heading', { name: 'Preferences' });
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

    fireEvent.click(screen.getByRole('menuitem', { name: /environment variables/i }));
    await screen.findByRole('heading', { name: 'Environment variables' });

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

    expect(screen.getByRole('heading', { name: 'Environment variables' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the target-user identity and admin-only access when an admin edits another user', async () => {
    const admin = makeUser({ user_id: 'admin-1', name: 'Ada', role: 'admin' });
    const target = makeUser({ user_id: 'user-2', name: 'Bob', role: 'member' });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={target}
        currentUser={admin}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    // Approved addition: the modal makes clear whose settings are being edited.
    expect(screen.getByText('Editing Bob')).toBeInTheDocument();
    // Personal API tokens are caller-scoped, so the entry is hidden here.
    expect(screen.queryByRole('menuitem', { name: /api tokens/i })).not.toBeInTheDocument();
    // Groups & Access is admin-only nav; the force-password control lives there.
    fireEvent.click(screen.getByRole('menuitem', { name: /groups & access/i }));
    await screen.findByRole('heading', { name: 'Groups & access' });
    expect(screen.getByText(/force password change/i)).toBeInTheDocument();
  });

  it('hides caller-scoped Codex ChatGPT controls when an admin edits another user', async () => {
    const admin = makeUser({ user_id: 'admin-1', name: 'Ada', role: 'admin' });
    const target = makeUser({
      user_id: 'user-2',
      name: 'Bob',
      agentic_auth_methods: { codex: 'subscription' },
    });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={target}
        currentUser={admin}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }));
    await screen.findByRole('heading', { name: 'Codex' });
    // Only the API-key path (which targets the edited user) is offered; the
    // ChatGPT sign-in / import-login-file controls act on the caller's own
    // login, so they must not appear when editing someone else.
    expect(screen.queryByText('Sign in with ChatGPT')).not.toBeInTheDocument();
    expect(screen.queryByText('Import login file')).not.toBeInTheDocument();
  });

  it('filters the sidebar via the search box', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'token' },
    });

    expect(screen.getByRole('menuitem', { name: /api tokens/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^profile$/i })).not.toBeInTheDocument();
  });

  it('surfaces a panel-content setting via global search and navigates on click', async () => {
    const user = makeUser();
    // "Volume" is a Preferences control, not a nav name — global search must find it.
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'volume' },
    });
    const hit = await screen.findByRole('menuitem', { name: /volume/i });
    // Only setting hits (no page match) — no divider should render. (The modal
    // is portaled to the document body, so query there, not the render root.)
    expect(document.querySelector('.ant-menu-item-divider')).not.toBeInTheDocument();
    fireEvent.click(hit);

    // Clicking the hit lands on the hosting panel and clears the query.
    await screen.findByRole('heading', { name: 'Preferences' });
    expect(screen.getByPlaceholderText('Search settings')).toHaveValue('');
  });

  it('ranks tab-membership above label-vs-keyword and divides pages from settings', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    // 'sec' matches: Security (page name), Password (only via keyword
    // 'security', but it lives in the matched Security tab), Only-play-for
    // (keyword 'seconds'), and Environment variables (page alias 'secrets').
    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'sec' },
    });

    const texts = (await screen.findAllByRole('menuitem')).map((el) => el.textContent ?? '');
    // Exact order: matched page, its own setting, then other-tab keyword-only
    // hits (a specific setting ahead of a broad page-alias hit).
    expect(texts).toHaveLength(4);
    expect(texts[0]).toMatch(/^Security/);
    expect(texts[1]).toMatch(/^Password/);
    expect(texts[2]).toMatch(/Only play for tasks longer than/);
    expect(texts[3]).toMatch(/Environment variables/);

    // Exactly one divider, at the page/settings boundary.
    expect(document.querySelectorAll('.ant-menu-item-divider')).toHaveLength(1);

    // Clicking a post-divider (setting) result navigates to its panel.
    fireEvent.click(screen.getByRole('menuitem', { name: /Only play for tasks longer than/i }));
    await screen.findByRole('heading', { name: 'Preferences' });
  });

  it('classifies multi-token page matches (every token must be in the page name)', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'code claude' },
    });

    // Both tokens occur in "Claude Code", so it's still classified as a page and
    // ranks first — and a divider separates it from its settings.
    const items = await screen.findAllByRole('menuitem');
    expect(items[0].textContent).toMatch(/^Claude Code/);
    expect(document.querySelectorAll('.ant-menu-item-divider')).toHaveLength(1);
  });

  it('indexes settings by their rendered label so on-screen text is findable', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    const search = screen.getByPlaceholderText('Search settings');
    for (const label of ['Use Slack avatar when available', 'Only play for tasks longer than']) {
      fireEvent.change(search, { target: { value: label } });
      expect(
        await screen.findByRole('menuitem', { name: new RegExp(label, 'i') })
      ).toBeInTheDocument();
    }
  });

  it('flushes edits from a panel the user navigated away from (no data loss)', async () => {
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

    // Edit Name on Profile, then move to Security and save from there.
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /security/i }));
    await screen.findByRole('heading', { name: 'Security' });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), {
      target: { value: 'new-secure-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // Both the Profile edit and the Security edit land in the flush.
    await waitFor(() => expect(onUpdate).toHaveBeenCalled(), ASYNC);
    const patch = onUpdate.mock.calls[0][1];
    expect(patch.name).toBe('Renamed');
    expect(patch.password).toBe('new-secure-password');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('flushes a dirty main-panel edit when saving from a provider tab', async () => {
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

    // Edit Name on Profile, then jump to a provider tab and save from there.
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('menuitem', { name: /^claude code/i }));
    await screen.findByRole('heading', { name: 'Claude Code' });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // The provider Save path must still commit the dirty Profile edit.
    await waitFor(() => {
      expect(onUpdate.mock.calls.some(([, patch]) => patch?.name === 'Renamed')).toBe(true);
    }, ASYNC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('persists the most-recently-edited tool MCP servers, not the first dirty tool', async () => {
    const user = makeUser({
      default_agentic_config: {
        'claude-code': { permissionMode: 'default' },
        codex: { permissionMode: 'ask' },
      },
      default_agentic_selection: {
        'claude-code': { source: 'inline' },
        codex: { source: 'inline' },
      },
      default_mcp_server_ids: [],
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

    // Dirty Claude first (so it sorts first in the dirty set), then edit the
    // user-level MCP list from Codex — the newer edit must win on save.
    // Claude Code has no credential fields in this mock, so its panel shows the
    // session defaults directly (no Authentication tab strip).
    fireEvent.click(screen.getByRole('menuitem', { name: /^claude code/i }));
    await screen.findByRole('heading', { name: 'Claude Code' });
    fireEvent.click(await screen.findByLabelText('claude-code acceptEdits'));

    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }));
    await screen.findByRole('heading', { name: 'Codex' });
    fireEvent.click(screen.getByText('Session defaults'));
    fireEvent.click(await screen.findByRole('button', { name: 'pick-mcp' }));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const patch = onUpdate.mock.calls.find(([, p]) => p?.default_mcp_server_ids)?.[1];
      expect(patch?.default_mcp_server_ids).toEqual(['mcp-picked']);
    }, ASYNC);
  });

  it('redirects an unauthorized deep-linked tab to Profile', async () => {
    // A non-admin editing self deep-linked to the admin-only Groups & access
    // panel must land on Profile, never rendering the admin content.
    const user = makeUser({ role: 'member' });
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
        initialTab="groups"
      />
    );

    await screen.findByRole('heading', { name: 'Profile' });
    expect(screen.queryByRole('heading', { name: 'Groups & access' })).not.toBeInTheDocument();
    expect(screen.queryByText('Force password change on next login')).not.toBeInTheDocument();
  });

  it('never loads the caller API keys when an admin opens tokens while editing another user', async () => {
    // A Feathers stub that records which services are touched. If the
    // caller-scoped tokens panel ever mounts, PersonalApiKeysTab fetches the
    // CALLER's keys under the edited user's identity — the leak we must prevent.
    const services: string[] = [];
    const client = {
      service: (name: string) => {
        services.push(name);
        return {
          findAll: vi.fn(async () => []),
          find: vi.fn(async () => ({ data: [] })),
          create: vi.fn(async () => ({})),
          remove: vi.fn(async () => ({})),
        };
      },
    } as unknown as AgorClient;

    const admin = makeUser({ user_id: 'admin-1', name: 'Ada', role: 'admin' });
    const target = makeUser({ user_id: 'user-2', name: 'Bob', role: 'member' });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={target}
        currentUser={admin}
        client={client}
        onUpdate={vi.fn()}
        initialTab="personal-api-keys"
      />
    );

    // The deep link resolves to Profile synchronously — the tokens panel never
    // mounts, so the api-keys service is never contacted.
    await screen.findByRole('heading', { name: 'Profile' });
    expect(screen.queryByRole('heading', { name: 'API tokens' })).not.toBeInTheDocument();
    expect(services).not.toContain('api/v1/user/api-keys');
  });

  it('cancels group sync and onClose when caller identity changes during a multi-step save', async () => {
    const adminA = makeUser({ user_id: 'admin-a', email: 'a@example.test', role: 'admin' });
    const adminB = makeUser({ user_id: 'admin-b', email: 'b@example.test', role: 'admin' });
    const target = makeUser({ user_id: 'target-user', email: 'target@example.test' });
    let resolveUpdate: (() => void) | undefined;
    const onUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        })
    );
    const onClose = vi.fn();
    const client = {
      service: (name: string) => ({
        findAll: vi.fn(async () =>
          name === 'groups'
            ? [{ group_id: 'group-1', name: 'Engineering', slug: 'engineering' }]
            : []
        ),
      }),
    } as unknown as AgorClient;
    let replaceCaller: (() => void) | undefined;

    function Harness() {
      const [caller, setCaller] = useState(adminA);
      replaceCaller = () => setCaller(adminB);
      return (
        <UserSettingsModal
          open
          onClose={onClose}
          user={target}
          currentUser={caller}
          client={client}
          onUpdate={onUpdate}
          initialTab="groups"
        />
      );
    }

    renderWithApp(<Harness />);
    await screen.findByRole('heading', { name: 'Groups & access' });
    await waitFor(() => expect(screen.getByLabelText('Groups')).toBeEnabled(), ASYNC);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce(), ASYNC);

    // The first update was dispatched as A. Replace the caller after commit but
    // before its promise continuation can read group form state or close B's UI.
    act(() => replaceCaller?.());
    resolveUpdate?.();
    await act(async () => Promise.resolve());

    expect(syncGroupsForUser).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Editing Admin')).toBeInTheDocument();
  });

  it('falls back to Profile for a deep link to a tenant-disabled provider', async () => {
    // Gemini is disabled for the tenant, so `provider:gemini` is not a visible
    // panel; a stale deep link to it must not render its credential controls.
    // Minimal seed — the modal only reads `.enabled` to decide visibility, and a
    // disabled tool is filtered out before any other field is touched.
    agorStore.getState().setAgenticToolSettings([{ tool: 'gemini', enabled: false }] as never);
    const user = makeUser();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
        initialTab="gemini"
      />
    );

    await screen.findByRole('heading', { name: 'Profile' });
    expect(screen.queryByRole('heading', { name: 'Gemini' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /gemini/i })).not.toBeInTheDocument();
  });

  it('preserves an in-progress audio edit across navigation (no draft loss)', async () => {
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
        initialTab="preferences"
      />
    );

    // Enable chimes on Preferences (audio defaults to disabled), then leave and
    // return: the draft must survive rather than reverting to persisted values.
    // Queried via querySelector to avoid jsdom `getComputedStyle` (cssstyle
    // 5.3.2 throws on AntD v6's `border: var()` rules).
    const enableChimes = () =>
      document.querySelector<HTMLInputElement>('input[aria-label="Enable chimes"]');
    await waitFor(() => expect(enableChimes()).not.toBeNull());
    expect(enableChimes()).not.toBeChecked();
    fireEvent.click(enableChimes() as HTMLInputElement);
    expect(enableChimes()).toBeChecked();

    fireEvent.click(screen.getByRole('menuitem', { name: /security/i }));
    await screen.findByRole('heading', { name: 'Security' });
    fireEvent.click(screen.getByRole('menuitem', { name: /preferences/i }));
    await screen.findByRole('heading', { name: 'Preferences' });
    // Draft survived the round trip rather than reverting to disabled.
    expect(enableChimes()).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      const patch = onUpdate.mock.calls.find(([, p]) => p?.preferences?.audio)?.[1];
      expect(patch?.preferences?.audio?.enabled).toBe(true);
    }, ASYNC);
  });

  it('shows and saves the primary coding agent from Preferences', async () => {
    const user = makeUser({ primary_agentic_tool: 'codex' });
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
        initialTab="preferences"
      />
    );

    const picker = await screen.findByRole('combobox', { name: 'Primary coding agent' });
    fireEvent.mouseDown(picker);
    const geminiOption = (await screen.findAllByText('Gemini')).find((element) =>
      element.closest('.ant-select-item-option')
    );
    expect(geminiOption).toBeDefined();
    fireEvent.click(geminiOption as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        user.user_id,
        expect.objectContaining({ primary_agentic_tool: 'gemini' }),
        expect.any(Function)
      );
    }, ASYNC);
    const [, , shouldApply] = onUpdate.mock.calls[0] as unknown as [string, unknown, () => boolean];
    expect(shouldApply()).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens a provider search hit on its own sub-tab (Session defaults, not Authentication)', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    // 'Sandbox Mode' is a Codex Session-defaults control; its search hit must
    // land on the Session defaults sub-tab, not the default Authentication view.
    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'Sandbox Mode' },
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sandbox Mode/i }));

    await screen.findByRole('heading', { name: 'Codex' });
    expect(screen.getByRole('tab', { name: 'Session defaults' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('opens package-owned OpenCode provider settings on Providers by default', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null}
        onUpdate={vi.fn()}
        initialTab="opencode"
      />
    );

    await screen.findByRole('heading', { name: 'OpenCode' });
    expect(screen.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true');
  });

  it('gives the dialog an accessible name even with the header hidden', () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    expect(screen.getByRole('dialog', { name: 'User Settings' })).toBeInTheDocument();
  });

  it('fails closed for a disabled-provider deep link while tenant settings hydrate', async () => {
    // Cold load: tenant tool settings have NOT hydrated yet, so the store reports
    // every tool as enabled. A `provider:` deep link must not fail open.
    agorStore.getState().reset();
    const services: string[] = [];
    const client = {
      service: (name: string) => {
        services.push(name);
        return {
          findAll: vi.fn(async () => []),
          find: vi.fn(async () => ({ data: [] })),
          create: vi.fn(async () => ({})),
          remove: vi.fn(async () => ({})),
          get: vi.fn(async () => ({})),
        };
      },
    } as unknown as AgorClient;
    const user = makeUser();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={client}
        onUpdate={vi.fn()}
        initialTab="codex"
      />
    );

    // During the hydration window the deep link resolves to Profile — no Codex
    // credential/default content mounts, so its services are never contacted.
    await screen.findByRole('heading', { name: 'Profile' });
    expect(screen.queryByRole('heading', { name: 'Codex' })).not.toBeInTheDocument();
    expect(services).not.toContain('agentic-tool-presets');
    expect(services).not.toContain('check-auth');

    // Settings arrive with Codex disabled — it stays closed.
    agorStore.getState().setAgenticToolSettings([{ tool: 'codex', enabled: false }] as never);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument()
    );
    expect(screen.queryByRole('heading', { name: 'Codex' })).not.toBeInTheDocument();
    expect(services).not.toContain('agentic-tool-presets');
  });

  it('does not leak a search sub-tab onto the next provider opened', async () => {
    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    // Codex is already active on its default Authentication sub-tab.
    fireEvent.click(screen.getByRole('menuitem', { name: /codex/i }));
    await screen.findByRole('heading', { name: 'Codex' });
    // A search hit for the ACTIVE provider's Session defaults switches its sub-tab.
    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'Sandbox Mode' },
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sandbox Mode/i }));
    expect(screen.getByRole('tab', { name: 'Session defaults' })).toHaveAttribute(
      'aria-selected',
      'true'
    );

    // Opening a DIFFERENT provider must land on its own default (Authentication),
    // not the sub-tab queued for Codex.
    fireEvent.click(screen.getByRole('menuitem', { name: /gemini/i }));
    await screen.findByRole('heading', { name: 'Gemini' });
    expect(screen.getByRole('tab', { name: 'Authentication' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('does not index credential fields hidden by the effective auth method', async () => {
    // On a ChatGPT subscription the OpenAI key field is not rendered, so a search
    // for it must not surface a hit that would land on a control that isn't there.
    const user = makeUser({ agentic_auth_methods: { codex: 'subscription' } });
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'OpenAI API Key' },
    });
    await screen.findByText(/No settings match/i);
    expect(screen.queryByRole('menuitem', { name: /OpenAI API Key/i })).not.toBeInTheDocument();
  });

  it('renders package-owned OpenCode readiness in the sidebar and provider header', async () => {
    const user = makeUser();
    const modelFind = vi.fn().mockResolvedValue({
      runtimeVersion: '1.14.33',
      providers: [{ id: 'openai', availableForSelection: true, models: [] }],
    });
    const authFind = vi.fn().mockResolvedValue({
      runtime: 'available',
      runtimeVersion: '1.14.33',
      isolation: { mode: 'simple', boundary: 'logical' },
      providers: [],
    });
    const presetFind = vi.fn().mockResolvedValue([]);
    const authentication = { accessToken: 'self' };
    const client = {
      service: vi.fn((path: string) => {
        if (path === 'opencode-models') return { find: modelFind };
        if (path === 'agentic-tool-presets') {
          return { find: presetFind, on: vi.fn(), off: vi.fn() };
        }
        return {
          find: authFind,
          get: vi.fn(),
          create: vi.fn(),
          patch: vi.fn(),
          remove: vi.fn(),
        };
      }),
      get: vi.fn(() => authentication),
      on: vi.fn(),
    } as unknown as AgorClient;

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={client}
        onUpdate={vi.fn()}
        initialTab="opencode"
      />
    );

    expect(
      await screen.findByRole('menuitem', { name: /OpenCode Available/i })
    ).toBeInTheDocument();
    const heading = await screen.findByRole('heading', { name: 'OpenCode' });
    expect(heading.parentElement).toHaveTextContent('Available');
    expect(modelFind).toHaveBeenCalled();
  });

  it('groups Primary Assistant within Preferences for the signed-in user', async () => {
    // Caller-scoped: the picker reads the signed-in user's primary teammate via
    // the users service. A null result leaves the select ready for a choice —
    // enough to prove the Preferences assistant section mounts the picker.
    const getPrimaryTeammate = vi.fn(async () => null);
    const getPrimaryTeammateCandidates = vi.fn(async () => []);
    const client = {
      service: (name: string) => {
        if (name === 'users') {
          return { getPrimaryTeammate, getPrimaryTeammateCandidates };
        }
        return { findAll: vi.fn(async () => []), find: vi.fn(async () => ({ data: [] })) };
      },
    } as unknown as AgorClient;

    const user = makeUser();
    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={client}
        onUpdate={vi.fn()}
      />
    );

    expect(screen.queryByRole('menuitem', { name: /primary assistant/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search settings'), {
      target: { value: 'primary assistant' },
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /primary assistant/i }));

    await screen.findByRole('heading', { name: 'Preferences' });
    expect(screen.getByRole('heading', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Developer tools' })).toBeInTheDocument();
    expect(screen.getByText('Primary assistant')).toBeInTheDocument();
    expect(await screen.findByText('Select a primary assistant')).toBeInTheDocument();
    expect(getPrimaryTeammate).toHaveBeenCalled();
  });

  it('redirects the former Primary Assistant deep link to Preferences', async () => {
    const getPrimaryTeammate = vi.fn(async () => null);
    const getPrimaryTeammateCandidates = vi.fn(async () => []);
    const client = {
      service: (name: string) => {
        if (name === 'users') {
          return { getPrimaryTeammate, getPrimaryTeammateCandidates };
        }
        return { findAll: vi.fn(async () => []), find: vi.fn(async () => ({ data: [] })) };
      },
    } as unknown as AgorClient;
    const user = makeUser();

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={client}
        onUpdate={vi.fn()}
        initialTab="primary-teammate"
      />
    );

    await screen.findByRole('heading', { name: 'Preferences' });
    expect(await screen.findByText('Select a primary assistant')).toBeInTheDocument();
  });

  it('hides the caller-scoped Primary Assistant preference when an admin edits another user', async () => {
    const admin = makeUser({ user_id: 'admin-1', name: 'Ada', role: 'admin' });
    const target = makeUser({ user_id: 'user-2', name: 'Bob', role: 'member' });

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={target}
        currentUser={admin}
        client={null as AgorClient | null}
        onUpdate={vi.fn()}
      />
    );

    await screen.findByRole('heading', { name: 'Profile' });
    expect(screen.queryByRole('menuitem', { name: /primary assistant/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /preferences/i }));
    await screen.findByRole('heading', { name: 'Preferences' });
    expect(screen.queryByText('Primary assistant')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Assistant' })).not.toBeInTheDocument();
  });
});

// The tenant tool-settings store is module-global. Seed it as HYDRATED (empty =
// every tool enabled) before each test so provider panels render, and clear any
// per-test override afterwards so visibility never leaks between tests.
beforeEach(() => {
  syncGroupsForUser.mockReset();
  __setAuthConfigForTests({ requireAuth: true });
  vi.spyOn(Grid, 'useBreakpoint').mockReturnValue({ md: true });
  agorStore.getState().setAgenticToolSettings([]);
});
afterEach(() => {
  agorStore.getState().setAgenticToolSettings([]);
  vi.unstubAllGlobals();
});

/**
 * Administrative fields are not self-edit profile data. `role` and
 * `unix_username` were seeded from the user and sent whenever their panel was
 * dirty — and the panel in view is marked dirty on open. These pin the payload,
 * because that is where the defect lived; a disabled field is not a request
 * boundary.
 */
describe('UserSettingsModal — administrative fields in save payloads', () => {
  it('omits role when a member saves their own profile', async () => {
    const user = makeUser({ role: 'member', unix_username: 'bob' });
    const onUpdate = vi.fn(async () => {});

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={user}
        currentUser={user}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    // No edit at all: the Profile panel is dirty from opening on it, which is
    // exactly the path that used to 403.
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
    }, ASYNC);

    const [, updates] = onUpdate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(updates).not.toHaveProperty('role');
    expect(updates).not.toHaveProperty('unix_username');
    // The fields they may set still go, so this is a narrowing and not a mute.
    expect(updates).toHaveProperty('name');
    expect(updates).toHaveProperty('email');
  });

  it('does not submit the disabled role selector when an admin edits themselves', async () => {
    const admin = makeUser({ role: 'admin' });
    const onUpdate = vi.fn(async () => {});

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={admin}
        currentUser={admin}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1), ASYNC);
    const [, updates] = onUpdate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(updates).not.toHaveProperty('role');
    expect(updates).toHaveProperty('name');
    expect(updates).toHaveProperty('email');
  });

  it('still sends role when an admin edits someone', async () => {
    const target = makeUser({ user_id: 'user-2', role: 'member' });
    const admin = makeUser({ user_id: 'user-1', role: 'admin' });
    const onUpdate = vi.fn(async () => {});

    renderWithApp(
      <UserSettingsModal
        open
        onClose={vi.fn()}
        user={target}
        currentUser={admin}
        client={null as AgorClient | null}
        onUpdate={onUpdate}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledTimes(1);
    }, ASYNC);

    const [, updates] = onUpdate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(updates).toHaveProperty('role', 'member');
  });
});

describe('UserSettingsModal — socket authority generations', () => {
  it('preserves a same-user password draft but never closes from an obsolete save', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const onUpdate = vi.fn(() => pending);
    const onClose = vi.fn();
    const user = makeUser({ user_id: 'same-user', role: 'member' });
    const view = (generation: number) => (
      <ConfigProvider theme={{ hashed: false }}>
        <AntApp>
          <ConnectionProvider
            value={{
              connected: true,
              connecting: false,
              authGeneration: generation,
              outOfSync: false,
              capturedSha: null,
              currentSha: null,
            }}
          >
            <UserSettingsModal
              open
              onClose={onClose}
              user={user}
              currentUser={user}
              client={null}
              onUpdate={onUpdate}
            />
          </ConnectionProvider>
        </AntApp>
      </ConfigProvider>
    );
    const rendered = render(view(10));
    fireEvent.click(screen.getByRole('menuitem', { name: /security/i }));
    const password = await screen.findByPlaceholderText('••••••••');
    fireEvent.change(password, { target: { value: 'same-user-password-draft' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledOnce(), ASYNC);

    rendered.rerender(view(11));
    await act(async () => {
      resolve();
      await pending;
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('••••••••')).toHaveValue('same-user-password-draft');
    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  }, 30_000);
});
