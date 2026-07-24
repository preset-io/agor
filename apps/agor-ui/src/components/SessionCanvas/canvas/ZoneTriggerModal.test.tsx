import type { BranchID, Session } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ZoneTriggerModal } from './ZoneTriggerModal';

// Isolate the modal's own smart-default selection logic from its heavy config
// children — the regression lives entirely in ZoneTriggerModal's render-time
// useMemo, which runs regardless of what these children render.
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
  const EffortField = ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string | undefined) => void;
  }) => (
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
  const EffortField = ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string | undefined) => void;
  }) => (
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

const makeSession = (id: string, status: string, lastUpdated: string, title: string): Session =>
  ({
    session_id: id,
    branch_id: BRANCH_ID,
    status,
    title,
    archived: false,
    created_at: '2026-01-01T00:00:00.000Z',
    last_updated: lastUpdated,
  }) as unknown as Session;

describe('ZoneTriggerModal smart-default session selection', () => {
  it('resolves the most-recent session without mutating the frozen store bucket', () => {
    const older = makeSession('s-old', 'completed', '2026-06-01T00:00:00.000Z', 'Older session');
    const newer = makeSession('s-new', 'completed', '2026-06-20T00:00:00.000Z', 'Newer session');

    // The store uses Immer, which deeply freezes every `sessionsByBranch`
    // bucket. Sorting such an array in place throws, so the modal must sort a
    // copy. Freeze here to reproduce the store's contract.
    const frozenBucket = Object.freeze([older, newer]);
    const sessionsByBranch = new Map<string, Session[]>([[BRANCH_ID, frozenBucket]]);

    expect(() =>
      render(
        <ZoneTriggerModal
          open
          onCancel={() => {}}
          client={null}
          branchId={BRANCH_ID}
          branch={undefined}
          sessionsByBranch={sessionsByBranch}
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
        open
        onCancel={() => {}}
        client={null}
        branchId={BRANCH_ID}
        branch={{ mcp_server_ids: ['branch-mcp'] } as never}
        sessionsByBranch={new Map([[BRANCH_ID, [claudeSession]]])}
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
        open
        onCancel={() => {}}
        client={null}
        branchId={BRANCH_ID}
        branch={undefined}
        sessionsByBranch={new Map([[BRANCH_ID, [codexSession]]])}
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
        open
        onCancel={() => {}}
        client={null}
        branchId={BRANCH_ID}
        branch={undefined}
        sessionsByBranch={new Map()}
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

  it.each([
    'fork',
    'spawn',
  ] as const)('folds an explicit effort into a reused session %s config', async (action) => {
    const session = {
      ...makeSession('s-codex', 'completed', '2026-06-20T00:00:00.000Z', 'Codex session'),
      agentic_tool: 'codex',
      model_config: { mode: 'alias', model: 'gpt-5.6-sol', effort: 'medium' },
      permission_config: { mode: 'allow-all' },
    } as unknown as Session;
    const onExecute = vi.fn().mockResolvedValue(undefined);

    render(
      <ZoneTriggerModal
        open
        onCancel={() => {}}
        client={null}
        branchId={BRANCH_ID}
        branch={undefined}
        sessionsByBranch={new Map([[BRANCH_ID, [session]]])}
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
  });
});
