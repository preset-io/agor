/** Session settings configuration regressions. */

import type { AgorClient, Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { SessionSettingsModal } from './SessionSettingsModal';

const persistUserDefaultFromForm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (sel: (s: unknown) => unknown) => sel({}),
}));
vi.mock('../../store/selectors', () => ({
  selectMcpServerById: () => new Map(),
  selectSessionMcpServerIds: () => new Map(),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));
vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  persistUserDefaultFromForm,
}));
// Chip-row stub that drives the shared `agenticToolPresetId` field.
vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: () => {
    const form = Form.useFormInstance();
    return (
      <div>
        <Form.Item name="agenticToolPresetId" hidden>
          <input />
        </Form.Item>
        <button
          type="button"
          data-testid="pick-inline"
          onClick={() => form.setFieldValue('agenticToolPresetId', '__inline__')}
        >
          inline
        </button>
        <button
          type="button"
          data-testid="pick-preset"
          onClick={() => form.setFieldValue('agenticToolPresetId', 'preset-1')}
        >
          preset
        </button>
        <button
          type="button"
          data-testid="pick-mcp"
          onClick={() => form.setFieldValue('mcpServerIds', ['mcp-1'])}
        >
          mcp
        </button>
        <button
          type="button"
          data-testid="save-default"
          onClick={() => form.setFieldValue('saveAsDefault', true)}
        >
          save default
        </button>
      </div>
    );
  },
}));
// Light stubs for the always-rendered primary-zone children.
vi.mock('../SessionMetadataForm', () => ({
  SessionMetadataForm: () => <div data-testid="meta" />,
}));
vi.mock('../SessionIds', () => ({ SessionIdsList: () => <div data-testid="ids" /> }));
// Secondary-collapse children (lazy, but stub to avoid heavy module work).
vi.mock('../CodexSettingsForm', () => ({ CodexSettingsForm: () => null }));
vi.mock('../CallbackConfigForm', () => ({ CallbackConfigForm: () => null }));
vi.mock('../CallbackToggleButton', () => ({ CallbackTargetDisplay: () => null }));
vi.mock('../AdvancedSettingsForm', () => ({ AdvancedSettingsForm: () => null }));
vi.mock('../SessionEnvVarsSelector', () => ({ SessionEnvVarsSelector: () => null }));

const claudeSession = {
  session_id: 's1',
  agentic_tool: 'claude-code',
  title: 'S',
  model_config: undefined,
  permission_config: { mode: 'acceptEdits' },
  agentic_tool_preset_id: null,
  callback_config: {},
  created_by: 'u1',
} as unknown as Session;

const codexSession = {
  ...claudeSession,
  session_id: 's-codex',
  agentic_tool: 'codex',
} as unknown as Session;

describe('SessionSettingsModal configuration', { timeout: 10_000 }, () => {
  it('persists MCP changes while a preset is selected', async () => {
    const onUpdateSessionMcpServers = vi.fn();
    render(
      <SessionSettingsModal
        open
        onClose={vi.fn()}
        session={{ ...claudeSession, agentic_tool_preset_id: 'preset-1' } as Session}
        client={null}
        currentUser={null}
        onUpdateSessionMcpServers={onUpdateSessionMcpServers}
      />
    );

    fireEvent.click(screen.getByTestId('pick-mcp'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdateSessionMcpServers).toHaveBeenCalledWith('s1', ['mcp-1']);
    });
  });

  it('only offers Codex sandbox and policy controls for inline configuration', async () => {
    render(
      <SessionSettingsModal
        open
        onClose={vi.fn()}
        session={codexSession}
        client={null}
        currentUser={null}
      />
    );

    expect(screen.getByText('Codex Sandbox & Policies')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() =>
      expect(screen.queryByText('Codex Sandbox & Policies')).not.toBeInTheDocument()
    );
  });

  it('does not repeat save-as-default after a successful close and reopen', async () => {
    persistUserDefaultFromForm.mockClear();
    const currentUser = { user_id: 'u1' } as unknown as User;
    const client = {} as AgorClient;
    const props = {
      session: claudeSession,
      onClose: vi.fn(),
      currentUser,
      client,
    };
    const { rerender } = render(<SessionSettingsModal {...props} open />);

    fireEvent.click(screen.getByTestId('save-default'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(persistUserDefaultFromForm).toHaveBeenCalledTimes(1));

    rerender(<SessionSettingsModal {...props} open={false} />);
    rerender(<SessionSettingsModal {...props} open />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(2));
    expect(persistUserDefaultFromForm).toHaveBeenCalledTimes(1);
  });
});
