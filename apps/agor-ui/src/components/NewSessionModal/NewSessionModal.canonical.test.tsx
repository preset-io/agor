/**
 * Regression: user defaults use the daemon's raw-tool-first lookup, with the
 * canonical key retained as a fallback for claude-code-cli.
 */

import type { User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionModal } from './NewSessionModal';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea data-testid="prompt-textarea" />,
}));
vi.mock('../AgentSelectionGrid/AgentSelectionGrid', () => ({
  AgentSelectionGrid: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button type="button" data-testid="pick-cli" onClick={() => onSelect('claude-code-cli')}>
      cli
    </button>
  ),
}));
vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: () => <div data-testid="chip-row" />,
}));
vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  SAVE_AS_DEFAULT_FIELD: 'saveAsDefault',
  persistUserDefaultFromForm: vi.fn(),
}));
vi.mock('../ModelSelector', () => ({
  AdvisorModelSelect: () => <div data-testid="advisor-select" />,
}));
vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ userById: new Map(), mcpServerById: new Map() }),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));

const currentUser = {
  user_id: 'u1',
  // Saved under the canonical key only — NOT under 'claude-code-cli'.
  default_agentic_config: {
    'claude-code': {
      modelConfig: { mode: 'exact', model: 'canon-model' },
      permissionMode: 'plan',
    },
  },
} as unknown as User;

describe('NewSessionModal canonical default read', { timeout: 10_000 }, () => {
  it('applies the claude-code default when creating a claude-code-cli session', async () => {
    const onCreate = vi.fn();
    render(
      <NewSessionModal
        open
        onClose={vi.fn()}
        onCreate={onCreate}
        availableAgents={[]}
        branchId="branch-1"
        currentUser={currentUser}
        client={null}
      />
    );

    // Switch to the CLI tool (stored default lives under the canonical key).
    fireEvent.click(screen.getByTestId('pick-cli'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Session' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const config = onCreate.mock.calls[0][0];
    expect(config.agent).toBe('claude-code-cli');
    expect(config.modelConfig?.model).toBe('canon-model');
    expect(config.permissionMode).toBe('plan');
  });
});
