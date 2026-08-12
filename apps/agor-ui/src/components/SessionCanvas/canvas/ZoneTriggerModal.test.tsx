import type { AgorClient, BranchID, Session } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTemplate } from '../../../utils/templates';
import { ZoneTriggerModal } from './ZoneTriggerModal';

vi.mock('../../../utils/templates', () => ({ renderTemplate: vi.fn() }));

function EffortField({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value: string | undefined) => void;
}) {
  return (
    <select
      aria-label="zone-effort"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value || undefined)}
    >
      <option value="">Inherited</option>
      <option value="medium">Medium</option>
      <option value="xhigh">X-High</option>
    </select>
  );
}

// Isolate the modal transaction behavior from its heavy configuration children.
vi.mock('../../AgentSelectionGrid', () => ({
  AgentSelectionGrid: ({
    agents,
    onSelect,
  }: {
    agents: { id: string }[];
    onSelect: (agent: string) => void;
  }) => (
    <>
      {agents.map((agent) => (
        <button key={agent.id} type="button" onClick={() => onSelect(agent.id)}>
          {agent.id}
        </button>
      ))}
    </>
  ),
}));
vi.mock('../../AgenticToolConfigForm', async () => {
  const actual = await vi.importActual<typeof import('../../AgenticToolConfigForm')>(
    '../../AgenticToolConfigForm'
  );
  const { Form } = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    AgenticToolConfigForm: () => (
      <Form.Item name="effort" noStyle>
        <EffortField />
      </Form.Item>
    ),
  };
});
vi.mock('../../AgenticToolConfigurationPicker', async () => {
  const { Form } = await vi.importActual<typeof import('antd')>('antd');
  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: () => (
      <Form.Item name="effort" noStyle>
        <EffortField />
      </Form.Item>
    ),
  };
});

const BRANCH_ID = 'branch-1' as BranchID;
const CLIENT = {} as AgorClient;
const renderTemplateMock = vi.mocked(renderTemplate);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const makeSession = (id: string, status: string, lastUpdated: string, title: string): Session =>
  ({
    session_id: id,
    branch_id: BRANCH_ID,
    agentic_tool: 'claude-code',
    status,
    title,
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: lastUpdated,
  }) as unknown as Session;

beforeEach(() => {
  renderTemplateMock.mockReset();
});

describe('ZoneTriggerModal action snapshot', () => {
  it('preserves prompt and form edits across equivalent parent data with new identities', async () => {
    const request = deferred<string>();
    renderTemplateMock.mockReturnValue(request.promise);
    const onExecute = vi.fn().mockResolvedValue(undefined);
    const props = {
      actionId: 1,
      open: true,
      onCancel: () => {},
      client: CLIENT,
      branch: { branch_id: BRANCH_ID, mcp_server_ids: ['initial-mcp'] } as never,
      sessions: [] as Session[],
      zoneName: 'Review',
      trigger: { template: 'Review {{ branch.name }}', behavior: 'show_picker' as const },
      boardName: 'Board',
      boardCustomContext: { sprint: 7 },
      availableAgents: [],
      mcpServerById: new Map(),
      currentUser: { default_mcp_server_ids: ['user-mcp'] } as never,
      onExecute,
    };
    const { rerender } = render(<ZoneTriggerModal {...props} />);

    const prompt = screen.getByRole('textbox', { name: 'Prompt (editable)' });
    fireEvent.change(prompt, { target: { value: 'My edited prompt' } });
    fireEvent.click(screen.getByText('Agentic Tool Configuration (optional)'));
    const effort = await screen.findByLabelText('zone-effort');
    fireEvent.change(effort, { target: { value: 'xhigh' } });

    rerender(
      <ZoneTriggerModal
        {...props}
        branch={{ branch_id: BRANCH_ID, mcp_server_ids: ['initial-mcp'] } as never}
        sessions={[]}
        trigger={{ template: 'Review {{ branch.name }}', behavior: 'show_picker' }}
        boardCustomContext={{ sprint: 7 }}
        mcpServerById={new Map()}
        currentUser={{ default_mcp_server_ids: ['user-mcp'] } as never}
      />
    );

    expect(renderTemplateMock).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveValue('My edited prompt');
    expect(effort).toHaveValue('xhigh');
    expect(screen.getByRole('button', { name: 'Execute Trigger' })).toBeEnabled();
    await act(async () => {
      request.resolve('Rendered once');
      await request.promise;
    });
    expect(prompt).toHaveValue('My edited prompt');
  });

  it('rerenders once and resets the prompt when the user deliberately changes session', async () => {
    renderTemplateMock.mockImplementation(async (_client, _template, context) => {
      const session = context.session as { description?: string } | undefined;
      return `Prompt for ${session?.description}`;
    });
    const older = {
      ...makeSession('s-old', 'completed', '2026-06-01T00:00:00.000Z', 'Older session'),
      description: 'older',
    } as Session;
    const newer = {
      ...makeSession('s-new', 'completed', '2026-06-20T00:00:00.000Z', 'Newer session'),
      description: 'newer',
    } as Session;

    render(
      <ZoneTriggerModal
        actionId={1}
        open
        onCancel={() => {}}
        client={CLIENT}
        branch={undefined}
        sessions={[older, newer]}
        zoneName="Review"
        trigger={{ template: 'Template', behavior: 'show_picker' }}
        availableAgents={[]}
        mcpServerById={new Map()}
        onExecute={async () => {}}
      />
    );

    const prompt = screen.getByRole('textbox', { name: 'Prompt (editable)' });
    await waitFor(() => expect(prompt).toHaveValue('Prompt for newer'));
    fireEvent.change(prompt, { target: { value: 'Edited newer prompt' } });

    fireEvent.mouseDown(screen.getByRole('combobox'));
    const olderOptions = await screen.findAllByText(/Older session/);
    fireEvent.click(olderOptions.at(-1) as HTMLElement);

    await waitFor(() => expect(prompt).toHaveValue('Prompt for older'));
    expect(renderTemplateMock).toHaveBeenCalledTimes(2);
  });

  it('starts a clean render exactly once for a new zone action or reopened action', async () => {
    const zoneA = deferred<string>();
    const zoneB = deferred<string>();
    const reopenedZoneA = deferred<string>();
    renderTemplateMock
      .mockReturnValueOnce(zoneA.promise)
      .mockReturnValueOnce(zoneB.promise)
      .mockReturnValueOnce(reopenedZoneA.promise);
    const common = {
      open: true,
      onCancel: () => {},
      client: CLIENT,
      branch: undefined,
      sessions: [] as Session[],
      availableAgents: [],
      mcpServerById: new Map(),
      onExecute: async () => {},
    };
    const { rerender } = render(
      <ZoneTriggerModal
        {...common}
        actionId={1}
        zoneName="Zone A"
        trigger={{ template: 'Template A', behavior: 'show_picker' }}
      />
    );
    let prompt = screen.getByRole('textbox', { name: 'Prompt (editable)' });
    expect(prompt).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Execute Trigger' })).toBeDisabled();
    zoneA.resolve('Rendered A');
    await waitFor(() => expect(prompt).toHaveValue('Rendered A'));
    fireEvent.change(prompt, { target: { value: 'Edited A' } });

    rerender(
      <ZoneTriggerModal
        {...common}
        actionId={2}
        zoneName="Zone B"
        trigger={{ template: 'Template B', behavior: 'show_picker' }}
      />
    );
    prompt = screen.getByRole('textbox', { name: 'Prompt (editable)' });
    expect(screen.getByText('Zone Trigger: Zone B')).toBeInTheDocument();
    expect(prompt).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Execute Trigger' })).toBeDisabled();
    zoneB.resolve('Rendered B');
    await waitFor(() => expect(prompt).toHaveValue('Rendered B'));

    rerender(
      <ZoneTriggerModal
        {...common}
        actionId={3}
        zoneName="Zone A"
        trigger={{ template: 'Template A', behavior: 'show_picker' }}
      />
    );
    prompt = screen.getByRole('textbox', { name: 'Prompt (editable)' });
    expect(prompt).toHaveValue('');
    reopenedZoneA.resolve('Reopened A');
    await waitFor(() => expect(prompt).toHaveValue('Reopened A'));
    expect(renderTemplateMock).toHaveBeenCalledTimes(3);
  });

  it('shares the initial render request when Strict Mode replays effects', async () => {
    const request = deferred<string>();
    renderTemplateMock.mockReturnValue(request.promise);

    render(
      <StrictMode>
        <ZoneTriggerModal
          actionId={1}
          open
          onCancel={() => {}}
          client={CLIENT}
          branch={undefined}
          sessions={[]}
          zoneName="Strict"
          trigger={{ template: 'Strict template', behavior: 'show_picker' }}
          availableAgents={[]}
          mcpServerById={new Map()}
          onExecute={async () => {}}
        />
      </StrictMode>
    );

    expect(renderTemplateMock).toHaveBeenCalledTimes(1);
    request.resolve('Strict rendered');
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Prompt (editable)' })).toHaveValue(
        'Strict rendered'
      )
    );
    expect(renderTemplateMock).toHaveBeenCalledTimes(1);
  });
});

describe('ZoneTriggerModal smart-default session selection', () => {
  it('resolves the most-recent session without mutating the frozen store bucket', () => {
    const older = makeSession('s-old', 'completed', '2026-06-01T00:00:00.000Z', 'Older session');
    const newer = makeSession('s-new', 'completed', '2026-06-20T00:00:00.000Z', 'Newer session');

    // The store uses Immer, which deeply freezes every `sessionsByBranch`
    // bucket. Sorting such an array in place throws, so the modal must sort a
    // copy. Freeze here to reproduce the store's contract.
    const frozenBucket = Object.freeze([older, newer]);
    expect(() =>
      render(
        <ZoneTriggerModal
          actionId={1}
          open
          onCancel={() => {}}
          client={null}
          branch={undefined}
          sessions={frozenBucket}
          zoneName="Zone"
          trigger={{ template: 'do {{thing}}' } as never}
          availableAgents={[]}
          mcpServerById={new Map()}
          onExecute={async () => {}}
        />
      )
    ).not.toThrow();

    // With no running sessions, the smart default is the most-recently-updated
    // session — surfaced as the closed Select's selected value.
    expect(document.body.textContent).toContain('Newer session');
    expect(document.body.textContent).not.toContain('Older session');
  });

  it('does not offer historical removed-runtime sessions for reuse', () => {
    const historical = {
      ...makeSession('s-historical', 'completed', '2026-06-20T00:00:00.000Z', 'Historical session'),
      agentic_tool: 'claude-code-cli',
    } as unknown as Session;

    render(
      <ZoneTriggerModal
        actionId={1}
        open
        onCancel={() => {}}
        client={null}
        branch={undefined}
        sessions={[historical]}
        zoneName="Zone"
        trigger={{ template: 'do {{thing}}' } as never}
        availableAgents={[]}
        mcpServerById={new Map()}
        onExecute={async () => {}}
      />
    );

    expect(screen.getByText('No existing sessions in this branch')).toBeInTheDocument();
    expect(screen.queryByText('Historical session')).not.toBeInTheDocument();
  });

  it('requires an explicit supported tool before a historical trigger creates a session', async () => {
    const onExecute = vi.fn().mockResolvedValue(undefined);
    render(
      <ZoneTriggerModal
        actionId={1}
        open
        onCancel={() => {}}
        client={null}
        branch={undefined}
        sessions={[]}
        zoneName="Zone"
        trigger={{
          template: 'prompt',
          behavior: 'always_new',
          agent: 'claude-code-cli',
        }}
        availableAgents={[{ id: 'codex', name: 'Codex' } as never]}
        mcpServerById={new Map()}
        onExecute={onExecute}
      />
    );

    expect(screen.getByText('This zone uses a removed agentic tool')).toBeInTheDocument();
    const execute = screen.getByRole('button', { name: 'Execute Trigger' });
    expect(execute).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    expect(execute).toBeEnabled();
    fireEvent.click(execute);

    await waitFor(() =>
      expect(onExecute).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
    );
  });
});

describe('ZoneTriggerModal reasoning effort', () => {
  it('does not inherit model or effort from another agent while preserving MCP inheritance', async () => {
    const claudeSession = {
      ...makeSession('s-claude', 'completed', '2026-06-20T00:00:00.000Z', 'Claude session'),
      agentic_tool: 'claude-code',
      model_config: { mode: 'alias', model: 'claude-opus-4-8', effort: 'max' },
      permission_config: { mode: 'bypassPermissions' },
    } as unknown as Session;
    const onExecute = vi.fn().mockResolvedValue(undefined);

    render(
      <ZoneTriggerModal
        actionId={1}
        open
        onCancel={() => {}}
        client={null}
        branch={{ mcp_server_ids: ['branch-mcp'] } as never}
        sessions={[claudeSession]}
        zoneName="Zone"
        trigger={{ template: 'prompt' } as never}
        availableAgents={[{ id: 'codex', name: 'Codex' } as never]}
        mcpServerById={new Map()}
        onExecute={onExecute}
      />
    );

    fireEvent.click(screen.getByText('Create a new session'));
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    fireEvent.click(screen.getByText('Agentic Tool Configuration (optional)'));
    await waitFor(() => expect(screen.getByLabelText('zone-effort')).toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() =>
      expect(onExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'codex',
          modelConfig: undefined,
          permissionMode: undefined,
          mcpServerIds: ['branch-mcp'],
        })
      )
    );
  });

  it('inherits model and effort from the newest session for the selected agent', async () => {
    const codexSession = {
      ...makeSession('s-codex', 'completed', '2026-06-20T00:00:00.000Z', 'Codex session'),
      agentic_tool: 'codex',
      model_config: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'medium' },
      permission_config: { mode: 'allow-all' },
    } as unknown as Session;
    const onExecute = vi.fn().mockResolvedValue(undefined);

    render(
      <ZoneTriggerModal
        actionId={1}
        open
        onCancel={() => {}}
        client={null}
        branch={undefined}
        sessions={[codexSession]}
        zoneName="Zone"
        trigger={{ template: 'prompt' } as never}
        availableAgents={[{ id: 'codex', name: 'Codex' } as never]}
        mcpServerById={new Map()}
        onExecute={onExecute}
      />
    );

    fireEvent.click(screen.getByText('Create a new session'));
    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() =>
      expect(onExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'codex',
          modelConfig: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'medium' },
          permissionMode: 'allow-all',
        })
      )
    );
  });

  it('folds an explicit Codex effort into a new session model config', async () => {
    const onExecute = vi.fn().mockResolvedValue(undefined);
    render(
      <ZoneTriggerModal
        actionId={1}
        open
        onCancel={() => {}}
        client={null}
        branch={undefined}
        sessions={[]}
        zoneName="Zone"
        trigger={{ template: 'prompt' } as never}
        availableAgents={[{ id: 'codex', name: 'Codex' } as never]}
        mcpServerById={new Map()}
        currentUser={
          {
            default_agentic_config: {
              codex: {
                modelConfig: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'medium' },
              },
            },
          } as never
        }
        onExecute={onExecute}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    fireEvent.click(screen.getByText('Agentic Tool Configuration (optional)'));
    const effort = await screen.findByLabelText('zone-effort');
    await waitFor(() => expect(effort).toHaveValue('medium'));
    fireEvent.change(effort, { target: { value: 'xhigh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

    await waitFor(() =>
      expect(onExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'codex',
          modelConfig: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'xhigh' },
        })
      )
    );
  });

  it.each(['fork', 'spawn'] as const)(
    'folds an explicit effort into a reused session %s config',
    async (action) => {
      const session = {
        ...makeSession('s-codex', 'completed', '2026-06-20T00:00:00.000Z', 'Codex session'),
        agentic_tool: 'codex',
        model_config: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'medium' },
        permission_config: { mode: 'allow-all' },
      } as unknown as Session;
      const onExecute = vi.fn().mockResolvedValue(undefined);

      render(
        <ZoneTriggerModal
          actionId={1}
          open
          onCancel={() => {}}
          client={null}
          branch={undefined}
          sessions={[session]}
          zoneName="Zone"
          trigger={{ template: 'prompt' } as never}
          availableAgents={[]}
          mcpServerById={new Map()}
          onExecute={onExecute}
        />
      );

      fireEvent.click(screen.getByText(new RegExp(`^${action}`, 'i')));
      fireEvent.click(screen.getByText('Session Configuration (codex)'));
      const effort = await screen.findByLabelText('zone-effort');
      await waitFor(() => expect(effort).toHaveValue('medium'));
      fireEvent.change(effort, { target: { value: 'xhigh' } });
      fireEvent.click(screen.getByRole('button', { name: 'Execute Trigger' }));

      await waitFor(() =>
        expect(onExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 's-codex',
            action,
            modelConfig: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'xhigh' },
          })
        )
      );
    }
  );
});
