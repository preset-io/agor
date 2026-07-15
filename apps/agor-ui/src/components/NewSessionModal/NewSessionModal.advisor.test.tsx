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
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../MCPServerSelect', () => ({
  SessionMcpServersField: () => <div data-testid="mcp-servers-field" />,
}));
vi.mock('../ModelSelector', () => ({
  AdvisorModelSelect: () => <div data-testid="advisor-select" />,
}));

// Picker stub that drives the shared `agenticToolPresetId` form field so the
// test can toggle inline vs preset configuration.
vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  persistUserDefaultFromForm: vi.fn(),
  AgenticToolConfigurationPicker: () => {
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

    // Expand the Advanced section (lazy-rendered); the MCP field confirms it opened.
    fireEvent.click(screen.getByText(/Advanced ·/));
    await screen.findByTestId('mcp-servers-field');

    // No configuration chosen yet → not inline → advisor hidden.
    expect(screen.queryByText('Advisor model')).not.toBeInTheDocument();

    // Choosing inline reveals the advisor override…
    fireEvent.click(screen.getByTestId('pick-inline'));
    await screen.findByText('Advisor model');

    // …and choosing a preset hides it again (it would be discarded).
    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() => expect(screen.queryByText('Advisor model')).not.toBeInTheDocument());
  });
});
