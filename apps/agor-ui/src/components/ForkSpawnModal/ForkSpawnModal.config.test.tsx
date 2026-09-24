/** Configuration regressions after the chip-row migration. */

import type { Session, SpawnConfig, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { buildSpawnPromptContext } from '../SessionPanel/spawn-prompt-context';
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
  AgentSelectionGrid: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button type="button" data-testid="pick-codex" onClick={() => onSelect('codex')}>
      codex
    </button>
  ),
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
        {['__user_default__', '__workspace_default__'].map((presetId) => (
          <button
            key={presetId}
            type="button"
            data-testid={presetId}
            onClick={() => form.setFieldValue('agenticToolPresetId', presetId)}
          >
            {presetId}
          </button>
        ))}
        <button
          type="button"
          data-testid="custom-claude"
          onClick={() =>
            form.setFieldsValue({
              agenticToolPresetId: '__inline__',
              permissionMode: 'bypassPermissions',
            })
          }
        >
          custom Claude
        </button>
        <button
          type="button"
          data-testid="custom-codex"
          onClick={() =>
            form.setFieldsValue({
              agenticToolPresetId: '__inline__',
              permissionMode: 'allow-all',
              codexSandboxMode: 'danger-full-access',
              codexApprovalPolicy: 'never',
              codexNetworkAccess: true,
            })
          }
        >
          custom Codex
        </button>
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
          data-testid="select-preset-mcp"
          onClick={() => {
            form.setFieldValue('agenticToolPresetId', 'preset-1');
            form.setFieldValue('mcpServerIds', ['mcp-1']);
          }}
        >
          select preset and MCP
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

const codexSession = {
  session_id: 'parent-codex',
  title: 'Codex parent',
  agentic_tool: 'codex',
  permission_config: { mode: 'auto' },
} as unknown as Session;

describe('ForkSpawnModal configuration defaults', { timeout: 10_000 }, () => {
  it('restores Codex-specific controls for inline custom spawns only', async () => {
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={codexSession}
        currentUser={null}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );

    fireEvent.click(screen.getByText('Custom config'));
    expect(await screen.findByText('Sandbox Mode')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() => expect(screen.queryByText('Sandbox Mode')).not.toBeInTheDocument());
  });

  it.each([
    { name: 'parent values', defaults: undefined, network: true, toggle: false },
    { name: 'explicit OFF', defaults: undefined, network: false, toggle: true },
    {
      name: 'legacy parent mapped defaults',
      defaults: undefined,
      network: true,
      toggle: false,
      legacy: true,
    },
    {
      name: 'parent network false',
      defaults: undefined,
      network: false,
      toggle: false,
      parentNetwork: false,
    },
    {
      name: 'saved user values override the parent, including false',
      defaults: {
        codexSandboxMode: 'read-only' as const,
        codexApprovalPolicy: 'untrusted' as const,
        codexNetworkAccess: false,
      },
      network: false,
      toggle: false,
    },
  ])(
    'shows and submits $name for untouched custom fields',
    async ({ defaults, network, toggle, legacy, parentNetwork }) => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      render(
        <ForkSpawnModal
          open
          action="spawn"
          session={{
            ...codexSession,
            permission_config: {
              mode: 'allow-all',
              codex: legacy
                ? undefined
                : {
                    sandboxMode: 'workspace-write',
                    approvalPolicy: 'never',
                    networkAccess: parentNetwork ?? true,
                  },
            },
          }}
          currentUser={defaults ? ({ default_agentic_config: { codex: defaults } } as User) : null}
          initialPrompt="Delegate"
          onConfirm={onConfirm}
          onCancel={vi.fn()}
          client={null}
          userById={new Map()}
        />
      );
      fireEvent.click(screen.getByText('Custom config'));
      const networkSwitch = await screen.findByRole('switch');
      expect(networkSwitch).toHaveAttribute('aria-checked', String(toggle || network));
      expect(screen.getByLabelText('Sandbox Mode').closest('.ant-select')).toHaveTextContent(
        defaults ? 'read-only' : 'workspace-write'
      );
      expect(screen.getByLabelText('Approval Policy').closest('.ant-select')).toHaveTextContent(
        defaults ? 'untrusted' : 'never'
      );
      if (toggle) fireEvent.click(networkSwitch);
      expect(networkSwitch).toHaveAttribute('aria-checked', String(network));
      fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
      expect(buildSpawnPromptContext(onConfirm.mock.calls[0][0])).toMatchObject({
        codexSandboxMode: defaults?.codexSandboxMode ?? 'workspace-write',
        codexApprovalPolicy: defaults?.codexApprovalPolicy ?? 'never',
        codexNetworkAccess: network,
      });
    }
  );

  it('does not send custom overrides after switching back to Same as parent', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={codexSession}
        initialPrompt="Inherit"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );
    fireEvent.click(screen.getByText('Custom config'));
    fireEvent.click(await screen.findByRole('switch'));
    fireEvent.click(screen.getByText('Same as parent'));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ prompt: 'Inherit' }));
  });

  it('keeps an inherited parent preset instead of submitting seeded inline fields', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={{ ...codexSession, agentic_tool_preset_id: 'preset-1' } as Session}
        initialPrompt="Inherit preset"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );
    fireEvent.click(screen.getByText('Custom config'));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    const config = onConfirm.mock.calls[0][0];
    expect(config.presetId).toBe('preset-1');
    expect(config).not.toHaveProperty('codexNetworkAccess');
    expect(config).not.toHaveProperty('permissionMode');
  });

  it("uses the target agent's default when changing agents", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const currentUser = {
      user_id: 'u2',
      default_agentic_selection: {
        codex: { source: 'preset', preset_id: 'codex-default' },
      },
    } as unknown as User;

    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={claudeSession}
        currentUser={currentUser}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );

    fireEvent.change(screen.getByTestId('prompt-textarea'), { target: { value: 'go' } });
    fireEvent.click(screen.getByText('Custom config'));
    fireEvent.click(screen.getByTestId('pick-codex'));
    fireEvent.click(screen.getByRole('button', { name: /Spawn Session/i }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0]).toEqual(
      expect.objectContaining({ agent: 'codex', presetId: '__user_default__' })
    );
  });

  it('includes MCP servers with a preset-backed custom configuration', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const currentUser = {
      user_id: 'u3',
      default_agentic_config: {},
      default_mcp_server_ids: [],
    } as unknown as User;
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={{ ...claudeSession, agentic_tool_preset_id: 'preset-1' } as Session}
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

describe('modal to SessionPanel spawn-prompt payload', () => {
  it.each(['__user_default__', '__workspace_default__', 'preset-1'])(
    'forwards the selected source %s without inline overrides',
    async (presetId) => {
      const create = vi.fn();
      render(
        <ForkSpawnModal
          open
          action="spawn"
          session={claudeSession}
          initialPrompt="Delegate"
          onConfirm={async (config) => {
            create(buildSpawnPromptContext(config));
          }}
          onCancel={vi.fn()}
          client={null}
          userById={new Map()}
        />
      );
      fireEvent.click(screen.getByText('Custom config'));
      fireEvent.click(screen.getByTestId(presetId === 'preset-1' ? 'pick-preset' : presetId));
      fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      expect(create.mock.calls[0][0]).toMatchObject({ userPrompt: 'Delegate', presetId });
      expect(create.mock.calls[0][0].permissionMode).toBeUndefined();
    }
  );

  it.each(['claude', 'codex'] as const)('forwards explicit custom %s permissions', async (tool) => {
    const create = vi.fn();
    render(
      <ForkSpawnModal
        open
        action="spawn"
        session={tool === 'codex' ? codexSession : claudeSession}
        initialPrompt="Delegate"
        onConfirm={async (config) => {
          create(buildSpawnPromptContext(config));
        }}
        onCancel={vi.fn()}
        client={null}
        userById={new Map()}
      />
    );
    fireEvent.click(screen.getByText('Custom config'));
    fireEvent.click(screen.getByTestId(`custom-${tool}`));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const expected: Partial<SpawnConfig> =
      tool === 'codex'
        ? {
            permissionMode: 'allow-all',
            codexSandboxMode: 'danger-full-access',
            codexApprovalPolicy: 'never',
            codexNetworkAccess: true,
          }
        : { permissionMode: 'bypassPermissions' };
    expect(create.mock.calls[0][0]).toMatchObject(expected);
    expect(create.mock.calls[0][0].presetId).toBeUndefined();
  });
});
