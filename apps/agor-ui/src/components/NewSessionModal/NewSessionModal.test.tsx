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

import type { User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
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
  AgentSelectionGrid: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <div data-testid="agent-grid">
      <button type="button" data-testid="pick-cli" onClick={() => onSelect('claude-code-cli')}>
        cli
      </button>
    </div>
  ),
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

vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  SAVE_AS_DEFAULT_FIELD: 'saveAsDefault',
  persistUserDefaultFromForm: vi.fn(),
  AgenticToolConfigurationPicker: () => <div data-testid="agentic-tool-config" />,
}));
vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: ({
    onConfigValidityChange,
  }: {
    onConfigValidityChange?: (valid: boolean, reason?: string) => void;
  }) => {
    const form = Form.useFormInstance();
    const source = Form.useWatch('agenticToolPresetId', form);
    return (
      <div data-testid="config-chip-row">
        <Form.Item name="agenticToolPresetId" hidden>
          <input />
        </Form.Item>
        <button
          type="button"
          data-testid="pick-preset"
          onClick={() => form.setFieldValue('agenticToolPresetId', 'preset-1')}
        >
          preset
        </button>
        <output data-testid="configuration-source">{source}</output>
        <button
          type="button"
          data-testid="cfg-invalid"
          onClick={() => onConfigValidityChange?.(false, 'Needs an administrator-managed preset')}
        >
          invalid
        </button>
        <button
          type="button"
          data-testid="cfg-valid"
          onClick={() => onConfigValidityChange?.(true)}
        >
          valid
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

// Antd Modal mount + async validateFields can exceed the default under the
// full CI suite (see ForkSpawnModal.test.tsx).
describe('NewSessionModal attachment intake', { timeout: 30_000 }, () => {
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

  it('clears the previous configuration source before a successful close and reopen', async () => {
    const onCreate = vi.fn();
    const props = {
      onClose: vi.fn(),
      onCreate,
      availableAgents: [],
      branchId: 'branch-1',
      client: null,
    };
    const { rerender } = render(<NewSessionModal {...props} open />);

    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() =>
      expect(screen.getByTestId('configuration-source')).toHaveTextContent('preset-1')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create Session' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));

    rerender(<NewSessionModal {...props} open={false} />);
    rerender(<NewSessionModal {...props} open />);
    await waitFor(() => expect(screen.getByTestId('configuration-source')).toBeEmptyDOMElement());
  });

  it('enables Create on the zero-input happy path and renders a suffix required mark', () => {
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

    expect(screen.getByRole('button', { name: 'Create Session' })).toBeEnabled();
    const label = screen.getByText('Coding Agent').closest('label') as HTMLElement;
    expect(label.textContent?.replace(/\s+/g, ' ').trim()).toMatch(/Coding Agent\s*\*$/);
  });

  it('disables Create with a reason when the configuration cannot resolve', async () => {
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
    const button = screen.getByRole('button', { name: 'Create Session' });

    fireEvent.click(screen.getByTestId('cfg-invalid'));
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.mouseOver(button.parentElement as HTMLElement);
    expect(await screen.findByText('Needs an administrator-managed preset')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('cfg-valid'));
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('applies a canonical claude-code default to a claude-code-cli session', async () => {
    const currentUser = {
      user_id: 'u1',
      default_agentic_config: {
        'claude-code': {
          modelConfig: { mode: 'exact', model: 'canon-model' },
          permissionMode: 'plan',
        },
      },
    } as unknown as User;
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

    fireEvent.click(screen.getByTestId('pick-cli'));
    fireEvent.click(screen.getByRole('button', { name: 'Create Session' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        agent: 'claude-code-cli',
        modelConfig: expect.objectContaining({ model: 'canon-model' }),
        permissionMode: 'plan',
      })
    );
  });
});
