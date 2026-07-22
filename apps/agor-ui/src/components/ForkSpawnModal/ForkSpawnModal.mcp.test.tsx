import type { Session, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { ForkSpawnModal } from './ForkSpawnModal';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => <textarea value={value} onChange={(event) => onChange(event.target.value)} />,
}));

vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: () => {
    const form = Form.useFormInstance();
    return (
      <button
        type="button"
        data-testid="select-preset-mcp"
        onClick={() => {
          form.setFieldValue('agenticToolPresetId', 'preset-1');
          form.setFieldValue('mcpServerIds', ['mcp-1']);
        }}
      >
        select preset and MCP
      </button>
    );
  },
}));

vi.mock('../AgentSelectionGrid/AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => <div />,
}));
vi.mock('../ModelSelector', () => ({ AdvisorModelSelect: () => null }));
vi.mock('../SessionEnvVarsSelector', () => ({ SessionEnvVarsSelector: () => null }));

const session = {
  session_id: 'session-parent',
  title: 'Parent Session',
  agentic_tool: 'claude-code',
  agentic_tool_preset_id: 'preset-1',
  callback_config: {},
} as unknown as Session;

const currentUser = {
  user_id: 'u1',
  default_agentic_config: {},
  default_mcp_server_ids: [],
} as unknown as User;

describe('ForkSpawnModal MCP submission', { timeout: 10_000 }, () => {
  it('includes MCP servers with a preset-backed custom configuration', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={session}
        currentUser={currentUser}
        initialPrompt="spawn a child"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );

    fireEvent.click(screen.getByText('Custom config'));
    fireEvent.click(await screen.findByTestId('select-preset-mcp'));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'spawn a child',
          presetId: 'preset-1',
          mcpServerIds: ['mcp-1'],
        })
      );
    });
  });
});
