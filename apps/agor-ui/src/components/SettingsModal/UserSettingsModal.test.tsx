import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

    fireEvent.click(screen.getByRole('menuitem', { name: /^claude code/i }));
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

  it('saves a new password from the Security panel and closes from the footer', async () => {
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

    fireEvent.click(screen.getByRole('menuitem', { name: /security/i }));
    await screen.findByRole('heading', { name: 'Security' });

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
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'new-pass' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // Both the Profile edit and the Security edit land in the flush.
    await waitFor(() => expect(onUpdate).toHaveBeenCalled(), ASYNC);
    const patch = onUpdate.mock.calls[0][1];
    expect(patch.name).toBe('Renamed');
    expect(patch.password).toBe('new-pass');
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
});
