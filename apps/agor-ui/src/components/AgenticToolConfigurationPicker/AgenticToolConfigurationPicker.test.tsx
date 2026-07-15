import type { AgorClient, User } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolConfigurationPicker } from './AgenticToolConfigurationPicker';

// Store: no per-tool override → inline configuration is allowed.
vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ agenticToolSettingsByName: new Map() }),
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

const makeClient = () =>
  ({
    service: () => ({
      find: async () => ({ data: [] }),
      on: () => {},
      off: () => {},
    }),
  }) as unknown as AgorClient;

const userWithDefault = {
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

function renderPicker(currentUser: User) {
  return render(
    <Form>
      <AgenticToolConfigurationPicker
        tool="claude-code"
        client={makeClient()}
        mcpServerById={new Map()}
        currentUser={currentUser}
        enableSaveAsDefault
      />
    </Form>
  );
}

describe('AgenticToolConfigurationPicker', () => {
  it('shows "My default" with resolved model + permission summary', async () => {
    renderPicker(userWithDefault);
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
