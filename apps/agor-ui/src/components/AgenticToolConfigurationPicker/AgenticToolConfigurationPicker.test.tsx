import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
  persistUserDefaultFromForm,
} from './AgenticToolConfigurationPicker';

const storeSettings = vi.hoisted(() => ({ inlineAllowed: true }));
vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({
      agenticToolSettingsByName: new Map([
        ['claude-code', { inline_configuration_allowed: storeSettings.inlineAllowed }],
        ['opencode', { inline_configuration_allowed: storeSettings.inlineAllowed }],
      ]),
    }),
}));

// Heavy children irrelevant to selection/labelling behavior.
vi.mock('../AgenticToolConfigForm', async () => {
  const actual = await vi.importActual<typeof import('../AgenticToolConfigForm')>(
    '../AgenticToolConfigForm'
  );
  return { ...actual, AgenticToolConfigForm: () => <div data-testid="inline-config-form" /> };
});
vi.mock('../MCPServerSelect', () => ({
  SessionMcpServersField: () => <div data-testid="mcp-servers-field" />,
}));

const makeClient = (presets: unknown[] = []) =>
  ({
    service: () => ({
      find: async () => ({ data: presets }),
      on: () => {},
      off: () => {},
    }),
  }) as unknown as AgorClient;

const userWithConfigDefault = {
  user_id: 'u1',
  default_agentic_config: {
    'claude-code': {
      modelConfig: { model: 'claude-sonnet-5' },
      permissionMode: 'acceptEdits',
    },
  },
} as unknown as User;

const userWithoutDefault = {
  user_id: 'u2',
  default_agentic_config: {},
} as unknown as User;

const teamPreset = {
  preset_id: 'p1',
  tool: 'claude-code',
  name: 'Team Preset',
  is_default: false,
  configuration: { modelConfig: { model: 'claude-opus-4-8' }, permissionMode: 'auto' },
};

afterEach(() => {
  storeSettings.inlineAllowed = true;
});

function renderPicker(
  currentUser: User,
  tool: AgenticToolName = 'claude-code',
  presets: unknown[] = [],
  initialSource?: string
) {
  return render(
    <Form initialValues={{ agenticToolPresetId: initialSource }}>
      <AgenticToolConfigurationPicker
        tool={tool}
        client={makeClient(presets)}
        mcpServerById={new Map()}
        currentUser={currentUser}
        enableSaveAsDefault
      />
      <Form.Item shouldUpdate noStyle>
        {({ getFieldValue }) => (
          <output data-testid="selected-source">{getFieldValue('agenticToolPresetId')}</output>
        )}
      </Form.Item>
    </Form>
  );
}

describe('AgenticToolConfigurationPicker', () => {
  it('shows "My default" with resolved model + permission summary', async () => {
    renderPicker(userWithConfigDefault);
    await waitFor(() =>
      expect(
        screen.getByText(/My default · Claude Sonnet 5 — 1M · Accept edits/)
      ).toBeInTheDocument()
    );
  });

  it('suppresses "My default" and preselects inline when the user has no default', async () => {
    renderPicker(userWithoutDefault);
    await waitFor(() => expect(screen.getByTestId('inline-config-form')).toBeInTheDocument());
    expect(screen.getByText('Customize for this session…')).toBeInTheDocument();
    expect(screen.queryByText('My default')).not.toBeInTheDocument();
    // Save-as-default is offered while inline config is active.
    expect(screen.getByText(/Save as my default/)).toBeInTheDocument();
  });

  it('keeps a preset-backed default reachable as "My default" with the preset summary', async () => {
    // Selection points at a preset (no inline config blob) — must not be hidden
    // or force-switched to inline.
    const user = {
      user_id: 'u3',
      default_agentic_config: {},
      default_agentic_selection: { 'claude-code': { source: 'preset', preset_id: 'p1' } },
    } as unknown as User;
    renderPicker(user, 'claude-code', [teamPreset]);
    await waitFor(() => expect(screen.getByText(/My default · Team Preset/)).toBeInTheDocument());
    // Not forced into inline.
    expect(screen.queryByTestId('inline-config-form')).not.toBeInTheDocument();
  });

  it('treats a workspace_default selection as a default (not hidden)', async () => {
    const user = {
      user_id: 'u4',
      default_agentic_config: {},
      default_agentic_selection: { 'claude-code': { source: 'workspace_default' } },
    } as unknown as User;
    renderPicker(user);
    await waitFor(() =>
      expect(screen.getByText(/My default · Workspace default/)).toBeInTheDocument()
    );
    expect(screen.queryByTestId('inline-config-form')).not.toBeInTheDocument();
  });

  it('preserves an explicit workspace default when built-in fallbacks are allowed', async () => {
    renderPicker(userWithoutDefault, 'claude-code', [], WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION);

    await waitFor(() =>
      expect(screen.getByTestId('selected-source')).toHaveTextContent(
        WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
      )
    );
  });

  it('selects an available preset when inline configuration is disabled without a workspace default', async () => {
    storeSettings.inlineAllowed = false;

    function Harness() {
      const [form] = Form.useForm();
      const source = Form.useWatch('agenticToolPresetId', form);
      return (
        <Form form={form}>
          <AgenticToolConfigurationPicker
            tool="claude-code"
            client={makeClient([teamPreset])}
            mcpServerById={new Map()}
            currentUser={userWithoutDefault}
          />
          <output data-testid="selected-source">{source}</output>
        </Form>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('selected-source')).toHaveTextContent('p1'));
  });

  it('does not expose an incomplete OpenCode workspace selection as My default', async () => {
    const user = {
      user_id: 'u-open-empty',
      default_agentic_config: {},
      default_agentic_selection: { opencode: { source: 'workspace_default' } },
    } as unknown as User;

    renderPicker(user, 'opencode');

    await waitFor(() =>
      expect(screen.getByTestId('selected-source')).toHaveTextContent(INLINE_AGENTIC_CONFIGURATION)
    );
    expect(screen.queryByText(/^My default/)).not.toBeInTheDocument();
  });

  it('renders OpenCode inline selection fail-closed without a subject-scoped catalog', async () => {
    render(
      <Form initialValues={{ agenticToolPresetId: INLINE_AGENTIC_CONFIGURATION }}>
        <AgenticToolConfigurationPicker
          tool="opencode"
          client={makeClient()}
          modelCatalogClient={null}
          mcpServerById={new Map()}
          currentUser={userWithoutDefault}
        />
      </Form>
    );

    expect(
      await screen.findByText('OpenCode model selection is unavailable for this execution owner')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('inline-config-form')).not.toBeInTheDocument();
    expect(screen.queryByText('Customize for this session…')).not.toBeInTheDocument();
  });

  it('prefers and summarizes a complete OpenCode workspace pair', async () => {
    const workspacePreset = {
      preset_id: 'opencode-workspace',
      tool: 'opencode',
      name: 'Workspace OpenCode',
      is_default: true,
      configuration: {
        modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
      },
    };

    renderPicker(userWithoutDefault, 'opencode', [workspacePreset]);

    await waitFor(() =>
      expect(screen.getByTestId('selected-source')).toHaveTextContent(
        WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
      )
    );
    expect(
      screen.getByText(/Workspace default · Workspace OpenCode · openai\/gpt-test/)
    ).toBeInTheDocument();
  });

  it('disables legacy OpenCode presets that do not contain an exact pair', async () => {
    renderPicker(userWithoutDefault, 'opencode', [
      {
        preset_id: 'legacy-preset',
        tool: 'opencode',
        name: 'Legacy preset',
        is_default: false,
        configuration: { permissionMode: 'yolo' },
      },
    ]);

    await waitFor(() => expect(screen.getByTestId('inline-config-form')).toBeInTheDocument());
    fireEvent.mouseDown(screen.getByRole('combobox'));
    expect(screen.getByText('Legacy preset').closest('.ant-select-item-option')).toHaveClass(
      'ant-select-item-option-disabled'
    );
  });
});

describe('persistUserDefaultFromForm', () => {
  it('writes the config + inline selection under the selected tool key', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const client = { service: () => ({ patch }) } as unknown as AgorClient;
    const user = {
      user_id: 'u9',
      default_agentic_config: {
        codex: { permissionMode: 'auto' },
        'claude-code': { permissionMode: 'plan' },
      },
      default_agentic_selection: {
        codex: { source: 'inline' },
        'claude-code': { source: 'workspace_default' },
      },
    } as unknown as User;

    await persistUserDefaultFromForm(client, user, 'gemini', {
      permissionMode: 'acceptEdits',
    });

    expect(patch).toHaveBeenCalledTimes(1);
    const [userId, payload] = patch.mock.calls[0];
    expect(userId).toBe('u9');
    expect(payload.default_agentic_config.gemini).toEqual({
      modelConfig: undefined,
      permissionMode: 'acceptEdits',
    });
    expect(payload.default_agentic_selection.gemini).toEqual({ source: 'inline' });
    // Existing per-tool entries are preserved.
    expect(payload.default_agentic_config.codex).toEqual({ permissionMode: 'auto' });
    expect(payload.default_agentic_selection.codex).toEqual({ source: 'inline' });
    expect(payload.default_agentic_config['claude-code']).toEqual({ permissionMode: 'plan' });
    expect(payload.default_agentic_selection['claude-code']).toEqual({
      source: 'workspace_default',
    });
  });
});

// #1963's schedule-run resolution copy is preserved for ScheduleModal (the only
// picker consumer that passes defaultResolution). Save-context surfaces show no
// banner (WS3 replaced it with inline resolved summaries), so #1963's original
// "save-time copy" assertion is intentionally dropped as obsolete.
const PRESET_ID = '00000000-0000-7000-8000-000000000001';

function renderSchedulePicker(
  initialSelection: string = USER_DEFAULT_AGENTIC_CONFIGURATION,
  client: AgorClient | null = makeClient()
) {
  return render(
    <Form initialValues={{ agenticToolPresetId: initialSelection }}>
      <AgenticToolConfigurationPicker
        tool="codex"
        client={client}
        mcpServerById={new Map()}
        defaultResolution="schedule-run"
      />
    </Form>
  );
}

describe('AgenticToolConfigurationPicker schedule-run resolution copy', () => {
  it('describes per-run user-default resolution for schedules', async () => {
    renderSchedulePicker(USER_DEFAULT_AGENTIC_CONFIGURATION);
    expect(
      await screen.findByText(
        "Resolved from the schedule creator's current default each time this schedule runs."
      )
    ).toBeInTheDocument();
  });

  it('describes per-run workspace-default resolution for schedules', async () => {
    renderSchedulePicker(WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION);
    expect(
      await screen.findByText(
        'Resolved from the current workspace default each time this schedule runs.'
      )
    ).toBeInTheDocument();
  });

  it('describes live resolution for a named schedule preset', async () => {
    const service = {
      find: vi.fn(async () => [
        { preset_id: PRESET_ID, name: 'Team preset', is_default: false, tool: 'codex' },
      ]),
      on: vi.fn(),
      off: vi.fn(),
    };
    const client = { service: () => service } as unknown as AgorClient;
    renderSchedulePicker(PRESET_ID, client);
    expect(
      await screen.findByText(
        'The latest version of this preset is used each time this schedule runs.'
      )
    ).toBeInTheDocument();
  });
});
