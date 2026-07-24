import type { AgorClient, User } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticConfigChipRow } from './AgenticConfigChipRow';

const storeSettings = vi.hoisted(() => ({ inlineAllowed: true }));
vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({
      agenticToolSettingsByName: new Map([
        ['claude-code', { inline_configuration_allowed: storeSettings.inlineAllowed }],
      ]),
    }),
}));

// Stub the heavy popover editors with buttons that fire their onChange.
vi.mock('../ModelSelector', async () => {
  const actual = await vi.importActual<typeof import('../ModelSelector')>('../ModelSelector');
  return {
    ...actual,
    ModelSelector: ({ onChange }: { onChange: (v: unknown) => void }) => (
      <button
        type="button"
        data-testid="model-change"
        onClick={() => onChange({ mode: 'alias', model: 'claude-haiku-4-5' })}
      >
        change model
      </button>
    ),
    AdvisorModelSelect: ({ onChange }: { onChange: (value: string) => void }) => (
      <button type="button" data-testid="advisor-select" onClick={() => onChange('advisor-model')}>
        choose advisor
      </button>
    ),
  };
});
vi.mock('../PermissionModeSelector', async () => {
  const actual = await vi.importActual<typeof import('../PermissionModeSelector')>(
    '../PermissionModeSelector'
  );
  return {
    ...actual,
    PermissionModeSelector: ({ onChange }: { onChange: (v: string) => void }) => (
      <button type="button" data-testid="perm-change" onClick={() => onChange('bypassPermissions')}>
        change perm
      </button>
    ),
  };
});
vi.mock('../EffortSelector', () => ({ EffortSelector: () => <div data-testid="effort-select" /> }));
vi.mock('../MCPServerSelect', () => ({ MCPServerSelect: () => <div data-testid="mcp-select" /> }));

const makeClient = () =>
  ({
    service: () => ({ find: async () => ({ data: [] }), on: () => {}, off: () => {} }),
  }) as unknown as AgorClient;

// No effort set → the chip must resolve to the effective default ("High").
const userWithDefault = {
  user_id: 'u1',
  default_agentic_config: {
    'claude-code': {
      modelConfig: { model: 'claude-opus-4-8' },
      permissionMode: 'acceptEdits',
    },
  },
} as unknown as User;

function Harness({
  user,
  client = makeClient(),
  initialSource,
}: {
  user: User;
  client?: AgorClient | null;
  initialSource?: string;
}) {
  const [form] = Form.useForm();
  return (
    <Form form={form} initialValues={{ agenticToolPresetId: initialSource }}>
      <AgenticConfigChipRow
        tool="claude-code"
        client={client}
        mcpServerById={new Map()}
        currentUser={user}
        enableSaveAsDefault
      />
      <Form.Item shouldUpdate noStyle>
        {() => (
          <span data-testid="state">
            {JSON.stringify({
              src: form.getFieldValue('agenticToolPresetId'),
              model: (form.getFieldValue('modelConfig') as { model?: string } | undefined)?.model,
              perm: form.getFieldValue('permissionMode'),
            })}
          </span>
        )}
      </Form.Item>
    </Form>
  );
}

afterEach(() => {
  storeSettings.inlineAllowed = true;
});

describe('AgenticConfigChipRow', () => {
  it('renders a source Select and resolved-value chips (effort resolves to the effective default)', async () => {
    render(<Harness user={userWithDefault} />);
    // Source Select shows the resolved "My default" summary.
    await waitFor(() =>
      expect(screen.getByText(/My default · Claude Opus 4.8 · Accept edits/)).toBeInTheDocument()
    );
    // Chips render real values — never "default".
    expect(screen.getByTestId('model-chip')).toHaveTextContent('Opus 4.8');
    expect(screen.getByTestId('permission-chip')).toHaveTextContent('Accept edits');
    expect(screen.getByTestId('effort-chip')).toHaveTextContent('Effort: High');
    expect(screen.getByTestId('effort-chip')).not.toHaveTextContent('default');
  });

  it('uses semantic, focusable buttons for popover chips', async () => {
    render(<Harness user={userWithDefault} initialSource={USER_DEFAULT_AGENTIC_CONFIGURATION} />);
    const modelChip = await screen.findByRole('button', { name: 'Model: Opus 4.8' });

    modelChip.focus();
    expect(modelChip).toHaveFocus();

    fireEvent.click(modelChip);
    expect(await screen.findByTestId('model-change')).toBeInTheDocument();
    expect(modelChip).toHaveAttribute('aria-expanded', 'true');

    const responsiveContainer = screen.getByTestId('model-change').parentElement;
    expect(responsiveContainer?.style.width).toBe('440px');
    expect(responsiveContainer?.style.maxWidth).toContain('100vw');
    expect(responsiveContainer?.style.minWidth).toBe('');
  });

  it('preserves the selected preset and offers retry when preset loading fails', async () => {
    const find = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        data: [
          {
            preset_id: 'preset-1',
            name: 'Team preset',
            tool: 'claude-code',
            configuration: {},
          },
        ],
      });
    const client = {
      service: () => ({ find, on: () => {}, off: () => {} }),
    } as unknown as AgorClient;

    render(<Harness user={userWithDefault} client={client} initialSource="preset-1" />);

    expect(await screen.findByText('Unable to load configuration presets')).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('state').textContent || '{}').src).toBe('preset-1');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText('Unable to load configuration presets')).not.toBeInTheDocument()
    );
    expect(JSON.parse(screen.getByTestId('state').textContent || '{}').src).toBe('preset-1');
  });

  it('preserves the selected preset while the client is unavailable', async () => {
    render(
      <Harness user={userWithDefault} client={null} initialSource="preset-while-disconnected" />
    );

    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('state').textContent || '{}').src).toBe(
        'preset-while-disconnected'
      )
    );
  });

  it('flips the Select to Custom (seeded from resolved values) when a chip is edited', async () => {
    render(<Harness user={userWithDefault} />);
    await waitFor(() =>
      expect(screen.getByText(/My default · Claude Opus 4.8/)).toBeInTheDocument()
    );

    // Open the model chip popover and change the model.
    fireEvent.click(screen.getByTestId('model-chip'));
    fireEvent.click(await screen.findByTestId('model-change'));

    // Select now reads "Custom"; chip reflects the new model.
    await waitFor(() => expect(screen.getByText('Custom')).toBeInTheDocument());
    expect(screen.getByTestId('model-chip')).toHaveTextContent('Haiku 4.5');

    const state = JSON.parse(screen.getByTestId('state').textContent || '{}');
    expect(state.src).toBe('__inline__');
    expect(state.model).toBe('claude-haiku-4-5');
    // Permission was seeded from the resolved default, not reset.
    expect(state.perm).toBe('acceptEdits');
  });

  it('owns the advisor control from the empty inline state', async () => {
    render(<Harness user={{ user_id: 'u2' } as User} initialSource="__inline__" />);

    const chip = await screen.findByRole('button', { name: 'Advisor model: Advisor: Off' });
    fireEvent.click(chip);
    fireEvent.click(await screen.findByTestId('advisor-select'));

    await waitFor(() => expect(chip).toHaveTextContent('Advisor: advisor-model'));
  });
});

const userWithInlineDefault = {
  user_id: 'u3',
  default_agentic_selection: { 'claude-code': { source: 'inline' } },
  default_agentic_config: { 'claude-code': { permissionMode: 'acceptEdits' } },
} as unknown as User;

function ValidityHarness({
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
  it('falls back from a disallowed inline user default to the workspace default', async () => {
    storeSettings.inlineAllowed = false;
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
      <ValidityHarness
        client={client}
        onValidity={onValidity}
        onValid={onValid}
        onInvalid={onInvalid}
      />
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

  it('rejects an inline user default disallowed by policy even when loading fails', async () => {
    storeSettings.inlineAllowed = false;
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
      <ValidityHarness
        client={client}
        onValidity={onValidity}
        onValid={onValid}
        onInvalid={onInvalid}
      />
    );

    await waitFor(() => {
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
