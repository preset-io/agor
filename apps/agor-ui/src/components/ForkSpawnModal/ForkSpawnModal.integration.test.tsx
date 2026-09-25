/** Exercise the real chip row, source resolver, permission editor and advanced controls together. */

import { resolveChildSessionConfig, resolveSessionDefaults } from '@agor/core/sessions';
import type {
  AgenticToolPreset,
  AgorClient,
  DefaultAgenticToolConfig,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { getDefaultModelForTool } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildSpawnPromptContext } from '../SessionPanel/spawn-prompt-context';
import { ForkSpawnModal } from './ForkSpawnModal';

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('../SessionEnvVarsSelector', () => ({ SessionEnvVarsSelector: () => null }));

const parent = {
  session_id: 'parent',
  title: 'Codex parent',
  agentic_tool: 'codex',
  model_config: { mode: 'exact', model: 'parent-only-model', effort: 'low' },
  permission_config: { mode: 'allow-all' },
} as Session;
const networkParent: Session = {
  ...parent,
  permission_config: {
    mode: 'allow-all',
    codex: { sandboxMode: 'danger-full-access', approvalPolicy: 'never', networkAccess: true },
  },
};
const sparse: DefaultAgenticToolConfig = { permissionMode: 'auto' };
const presets = [
  { preset_id: 'workspace', name: 'Team config', is_default: true },
  { preset_id: 'named', name: 'Named config', is_default: false },
].map((preset) => ({ ...preset, tool: 'codex', configuration: sparse }) as AgenticToolPreset);
const client = {
  service: () => ({ find: async () => ({ data: presets }), on: () => {}, off: () => {} }),
} as unknown as AgorClient;

function mount(session = parent, defaults?: DefaultAgenticToolConfig) {
  const user = defaults ? ({ default_agentic_config: { codex: defaults } } as User) : null;
  const submit = vi
    .fn<(config: string | Partial<SpawnConfig>) => Promise<void>>()
    .mockResolvedValue();
  render(
    <ForkSpawnModal
      open
      action="spawn"
      session={session}
      currentUser={user}
      client={client}
      userById={new Map()}
      initialPrompt="Delegate"
      onConfirm={submit}
      onCancel={vi.fn()}
    />
  );
  fireEvent.click(screen.getByText('Custom config'));
  return { submit, user };
}

async function selectOption(combo: HTMLElement, label: string) {
  fireEvent.mouseDown(combo);
  const option = await waitFor(() => {
    const match = [
      ...document.querySelectorAll<HTMLElement>(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option'
      ),
    ].find((el) => el.textContent?.startsWith(label));
    expect(match).toBeDefined();
    return match!;
  });
  fireEvent.click(option);
}
async function changeMode(label: string) {
  fireEvent.click(screen.getByTestId('permission-chip'));
  await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThan(3));
  await selectOption(screen.getAllByRole('combobox').at(-1)!, label);
}
async function expectAdvanced(sandbox: string, approval: string, network: boolean) {
  await waitFor(() => {
    expect(screen.getByLabelText('Sandbox Mode').closest('.ant-select')).toHaveTextContent(sandbox);
    expect(screen.getByLabelText('Approval Policy').closest('.ant-select')).toHaveTextContent(
      approval
    );
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', String(network));
  });
}
async function submitted(submit: ReturnType<typeof mount>['submit']) {
  fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  const payload = buildSpawnPromptContext(submit.mock.calls[0][0]);
  // JSON is the transport boundary: in particular false must not disappear.
  return JSON.parse(JSON.stringify(payload)) as typeof payload;
}

describe('spawn effective configuration through real AgenticConfigChipRow', () => {
  it('shows and transports mapped defaults on initial Custom with no saved user default', async () => {
    const { submit } = mount();
    await screen.findByRole('switch');
    await expectAdvanced('workspace-write', 'never', true);
    expect(await submitted(submit)).toMatchObject({
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'never',
      codexNetworkAccess: true,
    });
  });

  it('recomputes derived legacy parent fields when the permission chip changes to ask', async () => {
    const { submit } = mount();
    await screen.findByRole('switch');
    await changeMode('Untrusted');
    await expectAdvanced('read-only', 'untrusted', false);
    const payload = await submitted(submit);
    expect(payload).toMatchObject({
      permissionMode: 'ask',
      codexSandboxMode: 'read-only',
      codexApprovalPolicy: 'untrusted',
      codexNetworkAccess: false,
    });
    expect(
      resolveChildSessionConfig({ parent, overrides: payload }).permission_config.codex
    ).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'untrusted', networkAccess: false });
  });

  it('preserves genuinely explicit parent fields, including false, across mode changes', async () => {
    const { submit } = mount({
      ...networkParent,
      permission_config: {
        mode: 'allow-all',
        codex: { sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccess: false },
      },
    });
    await screen.findByRole('switch');
    await changeMode('Untrusted');
    await expectAdvanced('workspace-write', 'never', false);
    expect(await submitted(submit)).toMatchObject({
      permissionMode: 'ask',
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'never',
      codexNetworkAccess: false,
    });
  });

  it('preserves advanced choices made in the form while remaining derived fields follow mode', async () => {
    const { submit } = mount();
    await screen.findByRole('switch');
    await selectOption(screen.getByLabelText('Sandbox Mode'), 'full-access');
    fireEvent.click(screen.getByRole('switch')); // explicit false, not a missing value
    await changeMode('Untrusted');
    await expectAdvanced('full-access', 'untrusted', false);
    // Explicitly choose the currently-derived approval value, then change mode again.
    await selectOption(screen.getByLabelText('Approval Policy'), 'untrusted');
    await changeMode('Never ask');
    await expectAdvanced('full-access', 'untrusted', false);
    expect(await submitted(submit)).toMatchObject({
      permissionMode: 'allow-all',
      codexSandboxMode: 'danger-full-access',
      codexApprovalPolicy: 'untrusted',
      codexNetworkAccess: false,
    });
  });

  it.each([
    ['My default', '__user_default__'],
    ['Workspace default', '__workspace_default__'],
    ['Named config', 'named'],
  ])('detaches sparse %s without borrowing parent or unrelated user values', async (label) => {
    const defaults =
      label === 'My default'
        ? sparse
        : {
            permissionMode: 'allow-all' as const,
            codexNetworkAccess: true,
            codexApprovalPolicy: 'never' as const,
            modelConfig: { model: 'unrelated-user-model' },
          };
    const { submit, user } = mount(networkParent, defaults);
    await selectOption(await screen.findByLabelText('Configuration'), label);
    await waitFor(() => expect(screen.queryByRole('switch')).not.toBeInTheDocument());
    await selectOption(screen.getByLabelText('Configuration'), 'Custom');
    await screen.findByRole('switch');
    await expectAdvanced('workspace-write', 'on-request', false);
    const payload = await submitted(submit);
    expect(payload).not.toHaveProperty('presetId');
    expect(payload.modelConfig?.model).toBe(getDefaultModelForTool('codex'));
    expect(payload).toMatchObject({
      permissionMode: 'auto',
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'on-request',
      codexNetworkAccess: false,
    });
    // The selected source is atomic in backend materialization (no parent/user).
    const atomic = resolveSessionDefaults({ agenticTool: 'codex', overrides: sparse });
    const child = resolveChildSessionConfig({ parent: networkParent, user, overrides: payload });
    expect(child.permission_config).toEqual(atomic.permission_config);
    expect(child.model_config?.model).toEqual(atomic.model_config?.model);
  });

  it('detaches a sparse source by editing a chip and derives from the NEW mode', async () => {
    const { submit } = mount(networkParent, sparse);
    await selectOption(await screen.findByLabelText('Configuration'), 'My default');
    fireEvent.click(screen.getByTestId('permission-chip'));
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2));
    await selectOption(screen.getAllByRole('combobox').at(-1)!, 'Untrusted');
    await screen.findByRole('switch');
    await expectAdvanced('read-only', 'untrusted', false);
    expect(await submitted(submit)).toMatchObject({
      permissionMode: 'ask',
      codexSandboxMode: 'read-only',
      codexApprovalPolicy: 'untrusted',
      codexNetworkAccess: false,
    });
  });

  it.each([
    ['My default', '__user_default__'],
    ['Workspace default', '__workspace_default__'],
    ['Named config', 'named'],
  ])('retains selected %s as a reference with no inline overrides', async (label, presetId) => {
    const { submit } = mount(networkParent, sparse);
    await selectOption(await screen.findByLabelText('Configuration'), label);
    const payload = await submitted(submit);
    expect(payload.presetId).toBe(presetId);
    for (const key of [
      'permissionMode',
      'modelConfig',
      'codexNetworkAccess',
      'codexSandboxMode',
      'codexApprovalPolicy',
    ])
      expect(payload).not.toHaveProperty(key);
  });

  it('sends no overrides after returning to Same as parent', async () => {
    const { submit } = mount(networkParent, sparse);
    await screen.findByRole('switch');
    fireEvent.click(screen.getByText('Same as parent'));
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Session' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith({ prompt: 'Delegate' }));
  });
});
