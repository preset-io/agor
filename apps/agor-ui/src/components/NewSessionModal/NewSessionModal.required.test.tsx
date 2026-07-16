/**
 * Create-button gating: the happy path needs zero input (agent is preselected,
 * config defaults resolve), so the button is enabled by default. It only
 * disables — with an explanatory tooltip — when the configuration genuinely
 * can't resolve (admin inline-not-allowed with no preset).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionModal } from './NewSessionModal';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea data-testid="prompt-textarea" />,
}));
vi.mock('../AgentSelectionGrid/AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  SAVE_AS_DEFAULT_FIELD: 'saveAsDefault',
  persistUserDefaultFromForm: vi.fn(),
}));

// Chip-row stub that lets the test drive the reported config validity.
vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: ({
    onConfigValidityChange,
  }: {
    onConfigValidityChange?: (valid: boolean, reason?: string) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="cfg-invalid"
        onClick={() => onConfigValidityChange?.(false, 'Needs an admin-managed preset')}
      >
        invalid
      </button>
      <button type="button" data-testid="cfg-valid" onClick={() => onConfigValidityChange?.(true)}>
        valid
      </button>
    </div>
  ),
}));

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ userById: new Map(), mcpServerById: new Map() }),
}));
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showError: vi.fn() }),
}));

const renderModal = () =>
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

describe('NewSessionModal create-button gating', { timeout: 10_000 }, () => {
  it('enables Create on the happy path (agent preselected, config resolves)', () => {
    renderModal();
    expect(screen.getByRole('button', { name: 'Create Session' })).toBeEnabled();
  });

  it('renders the required mark as a suffix ("Coding Agent *"), not a prefix', () => {
    renderModal();
    const label = screen.getByText('Coding Agent').closest('label') as HTMLElement;
    // Asterisk follows the label text rather than antd's default "* Coding Agent".
    expect(label.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/Coding Agent\s*\*$/);
  });

  it('disables Create with a tooltip when the configuration cannot resolve', async () => {
    renderModal();
    const button = screen.getByRole('button', { name: 'Create Session' });

    fireEvent.click(screen.getByTestId('cfg-invalid'));
    await waitFor(() => expect(button).toBeDisabled());

    // The disabled button self-explains via a tooltip on its wrapper.
    const wrapper = button.parentElement as HTMLElement;
    fireEvent.mouseOver(wrapper);
    expect(await screen.findByText('Needs an admin-managed preset')).toBeInTheDocument();

    // Recovering makes it enabled again.
    fireEvent.click(screen.getByTestId('cfg-valid'));
    await waitFor(() => expect(button).toBeEnabled());
  });
});
