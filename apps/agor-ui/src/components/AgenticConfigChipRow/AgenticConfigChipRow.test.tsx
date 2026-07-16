import type { AgorClient, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import { AgenticConfigChipRow } from './AgenticConfigChipRow';

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({ agenticToolSettingsByName: new Map() }),
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
    AdvisorModelSelect: () => <div data-testid="advisor-select" />,
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

const userWithDefault = {
  user_id: 'u1',
  default_agentic_config: {
    'claude-code': {
      modelConfig: { model: 'claude-opus-4-8' },
      permissionMode: 'acceptEdits',
    },
  },
} as unknown as User;

function Harness({ user }: { user: User }) {
  const [form] = Form.useForm();
  return (
    <Form form={form}>
      <AgenticConfigChipRow
        tool="claude-code"
        client={makeClient()}
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

describe('AgenticConfigChipRow', () => {
  it('renders the resolved config as chips for the user default', async () => {
    render(<Harness user={userWithDefault} />);
    await waitFor(() => expect(screen.getByTestId('source-chip')).toHaveTextContent('My default'));
    expect(screen.getByTestId('model-chip')).toHaveTextContent('Opus 4.8');
    expect(screen.getByTestId('permission-chip')).toHaveTextContent('Accept edits');
  });

  it('switches the source to Custom (seeded from resolved values) when a config chip is edited', async () => {
    render(<Harness user={userWithDefault} />);
    await waitFor(() => expect(screen.getByTestId('source-chip')).toHaveTextContent('My default'));

    // Open the model chip popover and change the model.
    fireEvent.click(screen.getByTestId('model-chip'));
    fireEvent.click(await screen.findByTestId('model-change'));

    await waitFor(() => expect(screen.getByTestId('source-chip')).toHaveTextContent('Custom'));

    const state = JSON.parse(screen.getByTestId('state').textContent || '{}');
    expect(state.src).toBe('__inline__');
    expect(state.model).toBe('claude-haiku-4-5');
    // Permission was seeded from the resolved default, not reset.
    expect(state.perm).toBe('acceptEdits');
  });
});
