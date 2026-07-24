import type { AgenticToolName, AgorClient, User } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgenticToolConfigurationPicker,
  persistUserDefaultFromForm,
} from './AgenticToolConfigurationPicker';

const storeSettings = vi.hoisted(() => ({ inlineAllowed: true }));
vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({
      agenticToolSettingsByName: new Map([
        ['claude-code', { inline_configuration_allowed: storeSettings.inlineAllowed }],
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
      expect(screen.getByText(/My default · Claude Sonnet 5 · Accept edits/)).toBeInTheDocument()
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

  it('reads the default under the canonical key on claude-code-cli surfaces', async () => {
    // Default stored under 'claude-code'; the CLI surface must still see it.
    renderPicker(userWithConfigDefault, 'claude-code-cli');
    await waitFor(() => expect(screen.getByText(/My default/)).toBeInTheDocument());
    expect(screen.queryByTestId('inline-config-form')).not.toBeInTheDocument();
  });

  it('prefers a claude-code-cli default over the canonical fallback', async () => {
    const user = {
      user_id: 'u5',
      default_agentic_config: {
        'claude-code': { modelConfig: { model: 'claude-sonnet-5' } },
        'claude-code-cli': { modelConfig: { model: 'claude-opus-4-8' } },
      },
    } as unknown as User;

    renderPicker(user, 'claude-code-cli');

    await waitFor(() =>
      expect(screen.getByText(/My default · Claude Opus 4.8/)).toBeInTheDocument()
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

    await persistUserDefaultFromForm(client, user, 'claude-code-cli', {
      permissionMode: 'acceptEdits',
    });

    expect(patch).toHaveBeenCalledTimes(1);
    const [userId, payload] = patch.mock.calls[0];
    expect(userId).toBe('u9');
    expect(payload.default_agentic_config['claude-code-cli']).toEqual({
      modelConfig: undefined,
      permissionMode: 'acceptEdits',
    });
    expect(payload.default_agentic_selection['claude-code-cli']).toEqual({ source: 'inline' });
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
