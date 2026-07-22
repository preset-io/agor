/**
 * Regression test for the Advanced "Advisor model" control gating.
 *
 * The daemon overwrites model_config with the resolved preset/default config
 * when a non-inline configuration is chosen, so an advisor override set while a
 * preset/default is selected would be silently discarded. The control must only
 * appear while inline configuration is active.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionModal } from './NewSessionModal';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({ placeholder }: { placeholder?: string }) => (
    <textarea data-testid="prompt-textarea" placeholder={placeholder} />
  ),
}));
vi.mock('../AgentSelectionGrid/AgentSelectionGrid', () => ({
  AgentSelectionGrid: ({ onSelect }: { onSelect: (tool: string) => void }) => (
    <button type="button" data-testid="select-codex" onClick={() => onSelect('codex')}>
      Codex
    </button>
  ),
}));
vi.mock('../MCPServerSelect', () => ({
  SessionMcpServersField: () => <div data-testid="mcp-servers-field" />,
}));
vi.mock('../ModelSelector', () => ({
  AdvisorModelSelect: () => <div data-testid="advisor-select" />,
}));
vi.mock('../CodexSettingsForm', () => ({
  CodexSettingsForm: () => <div data-testid="codex-settings" />,
}));

vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  SAVE_AS_DEFAULT_FIELD: 'saveAsDefault',
  persistUserDefaultFromForm: vi.fn(),
}));

// Chip-row stub that drives the shared `agenticToolPresetId` field so the test
// can toggle inline vs preset configuration.
vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: () => {
    const form = Form.useFormInstance();
    return (
      <div>
        {/* Registered field so NewSessionModal's Form.useWatch reacts to setFieldValue. */}
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

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ userById: new Map(), mcpServerById: new Map() }),
}));
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showError: vi.fn() }),
}));

describe('NewSessionModal advisor gating', { timeout: 10_000 }, () => {
  it('only shows the Advanced advisor control while inline configuration is active', async () => {
    render(
      <NewSessionModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        availableAgents={[]}
        branchId="branch-1"
        client={null}
      />
    );

    // Expand the Advanced section (lazy-rendered).
    fireEvent.click(screen.getByText(/^Advanced/));

    // No configuration chosen yet → not inline → advisor hidden.
    expect(screen.queryByText('Advisor model')).not.toBeInTheDocument();

    // Choosing inline reveals the advisor override…
    fireEvent.click(screen.getByTestId('pick-inline'));
    await screen.findByText('Advisor model');

    // …and choosing a preset hides it again (it would be discarded).
    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() => expect(screen.queryByText('Advisor model')).not.toBeInTheDocument());
  });

  it('only shows Codex-specific controls while inline configuration is active', async () => {
    render(
      <NewSessionModal
        open
        onClose={vi.fn()}
        onCreate={vi.fn()}
        availableAgents={[]}
        branchId="branch-1"
        client={null}
      />
    );

    fireEvent.click(screen.getByTestId('select-codex'));
    fireEvent.click(screen.getByText(/^Advanced/));
    expect(screen.queryByTestId('codex-settings')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pick-inline'));
    expect(await screen.findByTestId('codex-settings')).toBeInTheDocument();
    expect(screen.getByText(/Codex sandbox/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() => expect(screen.queryByTestId('codex-settings')).not.toBeInTheDocument());
    expect(screen.queryByText(/Codex sandbox/)).not.toBeInTheDocument();
  });
});
