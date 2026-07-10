import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UserSettingsModal } from './UserSettingsModal';

vi.mock('../ApiKeyFields', () => ({
  ApiKeyFields: () => null,
  TOOL_FIELD_CONFIGS: Object.fromEntries(
    ['claude-code', 'claude-code-cli', 'codex', 'gemini', 'opencode', 'copilot', 'cursor'].map(
      (tool) => [tool, []]
    )
  ),
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
        mcpServerIds?: string[];
        modelConfig?: { mode?: string; model?: string };
      }
    ) => ({
      permissionMode: values.permissionMode,
      mcpServerIds: values.mcpServerIds ?? [],
      ...(values.modelConfig ? { modelConfig: values.modelConfig } : {}),
    }),
    getClearedFormValues: () => ({ permissionMode: 'default', mcpServerIds: [] }),
    getFormValuesFromConfig: (
      _tool: AgenticToolName,
      config?: {
        permissionMode?: string;
        mcpServerIds?: string[];
        modelConfig?: { mode?: string; model?: string };
      }
    ) => ({
      permissionMode: config?.permissionMode ?? 'default',
      mcpServerIds: config?.mcpServerIds ?? [],
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
        'claude-code': { permissionMode: 'default', mcpServerIds: [] },
        codex: { permissionMode: 'ask', mcpServerIds: [] },
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
    fireEvent.click(screen.getByLabelText('codex allow-all'));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith('user-1', {
        default_agentic_config: {
          'claude-code': { permissionMode: 'acceptEdits', mcpServerIds: [] },
          codex: { permissionMode: 'allow-all', mcpServerIds: [] },
        },
      });
    }, ASYNC);
    expect(onClose).toHaveBeenCalledTimes(1);
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
          mcpServerIds: [],
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
            mcpServerIds: [],
            modelConfig: { mode: 'alias', model: 'claude-opus-4-8' },
          },
        },
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
});
