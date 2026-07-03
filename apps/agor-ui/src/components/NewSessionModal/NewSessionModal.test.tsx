/**
 * Regression test for late attachment intake during session creation.
 *
 * Bug: after clicking "Create Session" the modal stays open for the whole
 * async create -> upload -> prompt cycle, but `attachmentFiles` was already
 * captured when the click fired. Files pasted/dropped in that window were
 * added to the tray yet silently never uploaded. The fix wires
 * `filesDropDisabled={isCreating}` on the initial-prompt AutocompleteTextarea
 * so file intake is refused while a session is being created.
 *
 * This test pins that wiring end to end: a paste is accepted before creation
 * but refused once `isCreating` is latched by an in-flight onCreate.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewSessionModal } from './NewSessionModal';

// Stand-in for AutocompleteTextarea: exposes `filesDropDisabled` as a data
// attribute and offers a paste trigger that mirrors the real component's gate
// (AutocompleteTextarea.tsx: `if (filesDropDisabled) return;`). The real
// component's own gating is covered by AutocompleteTextarea.test.tsx.
vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({
    value,
    onChange,
    onFilesDrop,
    filesDropDisabled,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    onFilesDrop?: (files: File[]) => void;
    filesDropDisabled?: boolean;
    placeholder?: string;
  }) => (
    <div>
      <textarea
        data-testid="prompt-textarea"
        data-files-drop-disabled={String(!!filesDropDisabled)}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        data-testid="simulate-paste"
        onClick={() => {
          if (filesDropDisabled) return;
          onFilesDrop?.([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
        }}
      >
        paste
      </button>
    </div>
  ),
}));

// Heavy children that need a live client/store are irrelevant to this test.
vi.mock('../AgentSelectionGrid/AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../MCPServerSelect', () => ({
  SessionMcpServersField: () => <div data-testid="mcp-servers-field" />,
}));
vi.mock('../AgenticToolConfigForm', async () => {
  const actual = await vi.importActual<typeof import('../AgenticToolConfigForm')>(
    '../AgenticToolConfigForm'
  );
  return { ...actual, AgenticToolConfigForm: () => <div data-testid="agentic-tool-config" /> };
});

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ userById: new Map(), mcpServerById: new Map() }),
}));
vi.mock('../../utils/message', () => ({
  useThemedMessage: () => ({ showError: vi.fn() }),
}));

// Antd Modal mount + async validateFields cycles brush against vitest's 5s
// default on slower runners (see ForkSpawnModal.test.tsx).
describe('NewSessionModal attachment intake', { timeout: 10_000 }, () => {
  it('refuses file intake while a session is being created', async () => {
    // onCreate never resolves, so the modal stays open with isCreating latched.
    const onCreate = vi.fn(() => new Promise<void>(() => {}));

    render(
      <NewSessionModal
        open
        onClose={vi.fn()}
        onCreate={onCreate}
        availableAgents={[]}
        branchId="branch-1"
        client={null}
      />
    );

    const removeButtons = () => screen.queryAllByRole('button', { name: /^Remove/ });

    // Intake is enabled before creation: a paste adds one tray item.
    expect(screen.getByTestId('prompt-textarea')).toHaveAttribute(
      'data-files-drop-disabled',
      'false'
    );
    fireEvent.click(screen.getByTestId('simulate-paste'));
    expect(removeButtons()).toHaveLength(1);

    // Start creation; isCreating latches because onCreate never resolves.
    fireEvent.click(screen.getByRole('button', { name: 'Create Session' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('prompt-textarea')).toHaveAttribute(
        'data-files-drop-disabled',
        'true'
      )
    );

    // A late paste during creation is refused: no new tray item is added.
    fireEvent.click(screen.getByTestId('simulate-paste'));
    expect(removeButtons()).toHaveLength(1);
  });
});
