import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
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

  return {
    AgenticToolConfigForm: ({ agenticTool }: { agenticTool: AgenticToolName }) => (
      <Form.Item name="permissionMode" label="Permission Mode">
        <Radio.Group>
          <Radio value="default">{agenticTool} default</Radio>
          <Radio value="acceptEdits">{agenticTool} acceptEdits</Radio>
          <Radio value="ask">{agenticTool} ask</Radio>
          <Radio value="allow-all">{agenticTool} allow-all</Radio>
        </Radio.Group>
      </Form.Item>
    ),
    buildConfigFromFormValues: (
      _tool: AgenticToolName,
      values: { permissionMode?: string; mcpServerIds?: string[] }
    ) => ({
      permissionMode: values.permissionMode,
      mcpServerIds: values.mcpServerIds ?? [],
    }),
    getClearedFormValues: () => ({ permissionMode: 'default', mcpServerIds: [] }),
    getFormValuesFromConfig: (
      _tool: AgenticToolName,
      config?: { permissionMode?: string; mcpServerIds?: string[] }
    ) => ({
      permissionMode: config?.permissionMode ?? 'default',
      mcpServerIds: config?.mcpServerIds ?? [],
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
  it('saves dirty agentic defaults across tabs with the active tab', async () => {
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
        mcpServerById={new Map()}
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
    expect(onClose).toHaveBeenCalled();
  });
});
