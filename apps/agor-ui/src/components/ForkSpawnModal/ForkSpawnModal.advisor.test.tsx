/**
 * Regression tests for ForkSpawnModal after the chip-row migration:
 *  A) the Claude advisor model is settable while inline ("Custom") config is
 *     active (the migration dropped the old advisor Select);
 *  B) user defaults are read under the canonical tool key, so a claude-code-cli
 *     spawn still picks up a default saved under claude-code.
 */

import type { Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ForkSpawnModal } from './ForkSpawnModal';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="prompt-textarea"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock('../AgentSelectionGrid/AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../ModelSelector', () => ({
  AdvisorModelSelect: () => <div data-testid="advisor-select" />,
}));
// Chip-row stub that registers + drives the shared `agenticToolPresetId` field.
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

const claudeSession = {
  session_id: 'parent',
  title: 'Parent',
  agentic_tool: 'claude-code',
} as unknown as Session;

describe('ForkSpawnModal advisor + canonical defaults', { timeout: 10_000 }, () => {
  it('shows the advisor control while inline config is active, hidden for a preset', async () => {
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={claudeSession}
        currentUser={null}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );

    // Enter custom config → seeded to inline → advisor available (set from empty).
    fireEvent.click(screen.getByText('Custom config'));
    await screen.findByText('Advisor model');

    // A preset hides it (the override would be discarded).
    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() => expect(screen.queryByText('Advisor model')).not.toBeInTheDocument());
  });

  it('reads a claude-code default under the canonical key for a claude-code-cli spawn', async () => {
    const cliSession = {
      session_id: 'parent-cli',
      title: 'Parent CLI',
      agentic_tool: 'claude-code-cli',
      permission_config: { mode: 'acceptEdits' },
    } as unknown as Session;
    const currentUser = {
      user_id: 'u1',
      // Saved under the canonical key only.
      default_agentic_config: {
        'claude-code': {
          modelConfig: { mode: 'exact', model: 'canon-model' },
          permissionMode: 'plan',
        },
      },
    } as unknown as User;
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={cliSession}
        currentUser={currentUser}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );

    fireEvent.change(screen.getByTestId('prompt-textarea'), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('Custom config'));
    fireEvent.click(screen.getByRole('button', { name: /Spawn Session/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const spawnConfig = onConfirm.mock.calls[0][0];
    // Canonical read → the claude-code default flows into the spawn config.
    expect(spawnConfig.modelConfig?.model).toBe('canon-model');
    expect(spawnConfig.permissionMode).toBe('plan');
  });
});
