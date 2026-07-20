import type { AgorClient } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticToolConfigurationPicker } from './AgenticToolConfigurationPicker';

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ agenticToolSettingsByName: new Map() }),
}));
vi.mock('../AgenticToolConfigForm', () => ({
  AgenticToolConfigForm: () => <div data-testid="inline-config" />,
}));
vi.mock('../MCPServerSelect', () => ({
  SessionMcpServersField: () => <div data-testid="mcp-field" />,
}));

const PRESET_ID = '00000000-0000-7000-8000-000000000001';

function renderPicker(
  defaultResolution?: 'save' | 'schedule-run',
  initialSelection = USER_DEFAULT_AGENTIC_CONFIGURATION,
  client: AgorClient | null = null
) {
  return render(
    <Form initialValues={{ agenticToolPresetId: initialSelection }}>
      <AgenticToolConfigurationPicker
        tool="codex"
        client={client}
        mcpServerById={new Map()}
        defaultResolution={defaultResolution}
      />
    </Form>
  );
}

describe('AgenticToolConfigurationPicker default resolution copy', () => {
  it('keeps save-time copy for existing consumers', async () => {
    renderPicker();
    expect(
      await screen.findByText(
        'The concrete preset or inline configuration will be resolved when this is saved.'
      )
    ).toBeInTheDocument();
  });

  it('describes per-run user-default resolution for schedules', async () => {
    renderPicker('schedule-run');
    expect(
      await screen.findByText(
        "Resolved from the schedule creator's current default each time this schedule runs."
      )
    ).toBeInTheDocument();
  });

  it('describes per-run workspace-default resolution for schedules', async () => {
    renderPicker('schedule-run', WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION);
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

    renderPicker('schedule-run', PRESET_ID, client);

    expect(
      await screen.findByText(
        'The latest version of this preset is used each time this schedule runs.'
      )
    ).toBeInTheDocument();
  });
});
