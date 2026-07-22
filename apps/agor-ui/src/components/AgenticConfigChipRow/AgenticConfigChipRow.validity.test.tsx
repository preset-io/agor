import type { AgorClient, User } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticConfigChipRow } from './AgenticConfigChipRow';

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({
      agenticToolSettingsByName: new Map([
        ['claude-code', { inline_configuration_allowed: false }],
      ]),
    }),
}));
vi.mock('../ModelSelector', async () => {
  const actual = await vi.importActual<typeof import('../ModelSelector')>('../ModelSelector');
  return { ...actual, ModelSelector: () => null, AdvisorModelSelect: () => null };
});
vi.mock('../PermissionModeSelector', async () => {
  const actual = await vi.importActual<typeof import('../PermissionModeSelector')>(
    '../PermissionModeSelector'
  );
  return { ...actual, PermissionModeSelector: () => null };
});
vi.mock('../EffortSelector', () => ({ EffortSelector: () => null }));
vi.mock('../MCPServerSelect', () => ({ MCPServerSelect: () => null }));

const userWithInlineDefault = {
  user_id: 'u1',
  default_agentic_selection: { 'claude-code': { source: 'inline' } },
  default_agentic_config: { 'claude-code': { permissionMode: 'acceptEdits' } },
} as unknown as User;

function Harness({
  client,
  onValidity,
  onValid,
  onInvalid,
}: {
  client: AgorClient;
  onValidity: (valid: boolean, reason?: string) => void;
  onValid: () => void;
  onInvalid: () => void;
}) {
  const [form] = Form.useForm();
  const source = Form.useWatch('agenticToolPresetId', form);

  return (
    <Form form={form} initialValues={{ agenticToolPresetId: USER_DEFAULT_AGENTIC_CONFIGURATION }}>
      <AgenticConfigChipRow
        tool="claude-code"
        client={client}
        mcpServerById={new Map()}
        currentUser={userWithInlineDefault}
        onConfigValidityChange={onValidity}
      />
      <button
        type="button"
        onClick={() => void form.validateFields().then(onValid).catch(onInvalid)}
      >
        Validate
      </button>
      <output data-testid="source">{source}</output>
    </Form>
  );
}

describe('AgenticConfigChipRow config validity', () => {
  it('validates every form consumer and falls back from a disallowed inline user default', async () => {
    const onValidity = vi.fn();
    const onValid = vi.fn();
    const onInvalid = vi.fn();
    let resolvePresets: ((value: { data: unknown[] }) => void) | undefined;
    const presets = new Promise<{ data: unknown[] }>((resolve) => {
      resolvePresets = resolve;
    });
    const client = {
      service: () => ({ find: () => presets, on: () => {}, off: () => {} }),
    } as unknown as AgorClient;

    render(
      <Harness client={client} onValidity={onValidity} onValid={onValid} onInvalid={onInvalid} />
    );

    await waitFor(() => {
      expect(onValidity).toHaveBeenLastCalledWith(false, 'Loading configuration');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(onInvalid).toHaveBeenCalledOnce());

    resolvePresets?.({
      data: [
        {
          preset_id: 'workspace-preset',
          tool: 'claude-code',
          name: 'Workspace preset',
          is_default: true,
          configuration: {},
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent(
        WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
      );
      expect(onValidity).toHaveBeenLastCalledWith(true, undefined);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(onValid).toHaveBeenCalledOnce());
  });

  it('rejects a known inline user default when preset loading fails', async () => {
    const onValidity = vi.fn();
    const onValid = vi.fn();
    const onInvalid = vi.fn();
    const client = {
      service: () => ({
        find: () => Promise.reject(new Error('preset service unavailable')),
        on: () => {},
        off: () => {},
      }),
    } as unknown as AgorClient;

    render(
      <Harness client={client} onValidity={onValidity} onValid={onValid} onInvalid={onInvalid} />
    );

    await waitFor(() => {
      expect(screen.getByTestId('source')).toHaveTextContent(USER_DEFAULT_AGENTIC_CONFIGURATION);
      expect(onValidity).toHaveBeenLastCalledWith(
        false,
        'This configuration is not allowed by workspace policy'
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    await waitFor(() => expect(onInvalid).toHaveBeenCalledOnce());
    expect(onValid).not.toHaveBeenCalled();
  });
});
