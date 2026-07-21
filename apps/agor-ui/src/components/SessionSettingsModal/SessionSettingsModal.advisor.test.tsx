/**
 * Regression: the Claude advisor model must be settable from SessionSettings
 * (the migration to the chip row dropped the old advisor Select). It appears
 * whenever Configuration is inline ("Custom") — even from an empty value — and
 * hides for a preset/default (where the daemon would discard the override).
 */

import type { Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { SessionSettingsModal } from './SessionSettingsModal';

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (sel: (s: unknown) => unknown) => sel({}),
}));
vi.mock('../../store/selectors', () => ({
  selectMcpServerById: () => new Map(),
  selectSessionMcpServerIds: () => new Map(),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));
vi.mock('../ModelSelector', () => ({
  AdvisorModelSelect: () => <div data-testid="advisor-select" />,
}));
vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  persistUserDefaultFromForm: vi.fn(),
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

describe('SessionSettingsModal advisor model', { timeout: 10_000 }, () => {
  it('lets the advisor be set from empty while inline, and hides it for a preset', async () => {
    render(
      <SessionSettingsModal
        open
        onClose={vi.fn()}
        session={claudeSession}
        client={null}
        currentUser={null}
      />
    );

    // Inline by default (no preset) → advisor visible even with no advisorModel set.
    expect(screen.getByText('Advisor model')).toBeInTheDocument();

    // Selecting a preset hides it (the override would be discarded).
    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() => expect(screen.queryByText('Advisor model')).not.toBeInTheDocument());

    // Back to inline → available again.
    fireEvent.click(screen.getByTestId('pick-inline'));
    await screen.findByText('Advisor model');
  });
});
