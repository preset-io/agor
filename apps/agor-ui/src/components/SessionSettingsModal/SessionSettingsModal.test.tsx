/** Session settings configuration regressions. */

import type { AgorClient, Session, User } from '@agor-live/client';
import { SESSION_LIST_ROW_SHAPE } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { SessionSettingsModal } from './SessionSettingsModal';

const persistUserDefaultFromForm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (sel: (s: unknown) => unknown) => sel({}),
}));
vi.mock('../../store/selectors', () => ({
  selectMcpServerById: () => new Map(),
  selectSessionMcpServerIds: () => new Map(),
}));
vi.mock('../../utils/message', () => ({ useThemedMessage: () => ({ showError: vi.fn() }) }));
vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
  persistUserDefaultFromForm,
}));
// Chip-row stub that drives the shared `agenticToolPresetId` field.
vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: ({ showEffort = true }: { showEffort?: boolean }) => {
    const form = Form.useFormInstance();
    return (
      <div>
        {showEffort && <div data-testid="effort-chip" />}
        <Form.Item name="agenticToolPresetId" hidden>
          <input />
        </Form.Item>
        <button
          type="button"
          data-testid="pick-inline"
          onClick={() => form.setFieldValue('agenticToolPresetId', '__inline__')}
        >
          inline
        </button>
        <button
          type="button"
          data-testid="pick-preset"
          onClick={() => form.setFieldValue('agenticToolPresetId', 'preset-1')}
        >
          preset
        </button>
        <button
          type="button"
          data-testid="pick-mcp"
          onClick={() => form.setFieldValue('mcpServerIds', ['mcp-1'])}
        >
          mcp
        </button>
        <button
          type="button"
          data-testid="save-default"
          onClick={() => form.setFieldValue('saveAsDefault', true)}
        >
          save default
        </button>
      </div>
    );
  },
}));
// Light stubs for the always-rendered primary-zone children.
vi.mock('../SessionMetadataForm', () => ({
  SessionMetadataForm: () => <div data-testid="meta" />,
}));
vi.mock('../SessionIds', () => ({ SessionIdsList: () => <div data-testid="ids" /> }));
// Secondary-collapse children (lazy, but stub to avoid heavy module work).
vi.mock('../CodexSettingsForm', () => ({ CodexSettingsForm: () => null }));
vi.mock('../CallbackConfigForm', () => ({ CallbackConfigForm: () => null }));
vi.mock('../CallbackToggleButton', () => ({ CallbackTargetDisplay: () => null }));
vi.mock('../AdvancedSettingsForm', () => ({
  AdvancedSettingsForm: ({ disabled }: { disabled?: boolean }) => (
    <Form.Item name="custom_context">
      <textarea data-testid="custom-context" readOnly={disabled} />
    </Form.Item>
  ),
}));
vi.mock('../SessionEnvVarsSelector', () => ({ SessionEnvVarsSelector: () => null }));

const claudeSession = {
  session_id: 's1',
  agentic_tool: 'claude-code',
  title: 'S',
  model_config: undefined,
  permission_config: { mode: 'acceptEdits' },
  agentic_tool_preset_id: null,
  callback_config: {},
  created_by: 'u1',
} as unknown as Session;

const codexSession = {
  ...claudeSession,
  session_id: 's-codex',
  agentic_tool: 'codex',
} as unknown as Session;

describe('SessionSettingsModal configuration', { timeout: 10_000 }, () => {
  it('shows historical removed-runtime sessions as read-only', () => {
    render(
      <SessionSettingsModal
        open
        onClose={vi.fn()}
        session={{ ...claudeSession, agentic_tool: 'claude-code-cli' } as Session}
        client={null}
        currentUser={null}
      />
    );

    expect(screen.getByText('Historical Session')).toBeInTheDocument();
    expect(screen.getByText(/runtime settings cannot be changed/i)).toBeInTheDocument();
    expect(screen.queryByTestId('effort-chip')).not.toBeInTheDocument();
  });

  it('persists MCP changes while a preset is selected', async () => {
    const onUpdateSessionMcpServers = vi.fn();
    render(
      <SessionSettingsModal
        open
        onClose={vi.fn()}
        session={{ ...claudeSession, agentic_tool_preset_id: 'preset-1' } as Session}
        client={null}
        currentUser={null}
        onUpdateSessionMcpServers={onUpdateSessionMcpServers}
      />
    );

    fireEvent.click(screen.getByTestId('pick-mcp'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onUpdateSessionMcpServers).toHaveBeenCalledWith('s1', ['mcp-1']);
    });
  });

  it('only offers Codex sandbox and policy controls for inline configuration', async () => {
    render(
      <SessionSettingsModal
        open
        onClose={vi.fn()}
        session={codexSession}
        client={null}
        currentUser={null}
      />
    );

    expect(screen.getByText('Codex Sandbox & Policies')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pick-preset'));
    await waitFor(() =>
      expect(screen.queryByText('Codex Sandbox & Policies')).not.toBeInTheDocument()
    );
  });

  it('offers env var editing to the creator only when a save handler is wired', () => {
    const props = {
      open: true,
      session: claudeSession,
      onClose: vi.fn(),
      currentUser: { user_id: 'u1' } as unknown as User,
      client: {} as AgorClient,
    };
    const { rerender } = render(
      <SessionSettingsModal {...props} onUpdateSessionEnvSelections={vi.fn()} />
    );
    expect(screen.getByText('Environment Variables')).toBeInTheDocument();

    // An editable section nobody persists would drop edits silently, so it is not rendered.
    rerender(<SessionSettingsModal {...props} />);
    expect(screen.queryByText('Environment Variables')).not.toBeInTheDocument();
  });

  it('does not repeat save-as-default after a successful close and reopen', async () => {
    persistUserDefaultFromForm.mockClear();
    const currentUser = { user_id: 'u1' } as unknown as User;
    const client = {} as AgorClient;
    const props = {
      session: claudeSession,
      onClose: vi.fn(),
      currentUser,
      client,
    };
    const { rerender } = render(<SessionSettingsModal {...props} open />);

    fireEvent.click(screen.getByTestId('save-default'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(persistUserDefaultFromForm).toHaveBeenCalledTimes(1));

    rerender(<SessionSettingsModal {...props} open={false} />);
    rerender(<SessionSettingsModal {...props} open />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(2));
    expect(persistUserDefaultFromForm).toHaveBeenCalledTimes(1);
  });

  describe('custom_context from a lean session row', () => {
    const fullContext = {
      teamName: 'Backend',
      scheduled_run: { schedule_id: 'sched-1' },
      slash_commands: ['/review'],
    };
    const leanSession = {
      ...claudeSession,
      custom_context: { teamName: 'Backend' },
      read_shape: SESSION_LIST_ROW_SHAPE,
    } as unknown as Session;
    const fullSession = { ...claudeSession, custom_context: fullContext } as unknown as Session;

    const connection = (authGeneration: number) => ({
      connected: true,
      connecting: false,
      authGeneration,
      outOfSync: false,
      capturedSha: null,
      currentSha: null,
    });
    const withConnection = (authGeneration: number, node: React.ReactNode) => (
      <ConnectionProvider value={connection(authGeneration)}>{node}</ConnectionProvider>
    );

    function clientReturning(session: Partial<Session>) {
      const get = vi.fn().mockResolvedValue({ ...claudeSession, ...session });
      return { client: { service: () => ({ get }) } as unknown as AgorClient, get };
    }

    it('does not send custom_context on a save that did not edit it', async () => {
      const onUpdate = vi.fn();
      const { client, get } = clientReturning({ custom_context: fullContext });
      render(
        <SessionSettingsModal
          open
          onClose={vi.fn()}
          session={leanSession}
          client={client}
          currentUser={null}
          onUpdate={onUpdate}
        />
      );
      await waitFor(() => expect(get).toHaveBeenCalledWith('s1'));

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      expect(onUpdate.mock.calls[0][1]).not.toHaveProperty('custom_context');
    });

    it('shows a degraded state and stays read-only when the full record cannot load', async () => {
      const onUpdate = vi.fn();
      const get = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(fullSession);
      render(
        <SessionSettingsModal
          open
          onClose={vi.fn()}
          session={leanSession}
          client={{ service: () => ({ get }) } as unknown as AgorClient}
          currentUser={null}
          onUpdate={onUpdate}
        />
      );
      expect(await screen.findByText('(details unavailable)')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Advanced'));
      const field = (await screen.findByTestId('custom-context')) as HTMLTextAreaElement;
      expect(screen.getByText(/Could not load full session details: offline/)).toBeInTheDocument();
      expect(field.readOnly).toBe(true);

      // Saving other settings while degraded never sends the lean context.
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      expect(onUpdate.mock.calls[0][1]).not.toHaveProperty('custom_context');

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(field.readOnly).toBe(false));
      expect(JSON.parse(field.value)).toEqual(fullContext);
      expect(screen.queryByText('(details unavailable)')).not.toBeInTheDocument();
    });

    it('retries a failed load after a socket reconnect', async () => {
      const get = vi
        .fn()
        .mockRejectedValueOnce(new Error('socket closed'))
        .mockResolvedValueOnce(fullSession);
      const client = { service: () => ({ get }) } as unknown as AgorClient;
      const modal = (
        <SessionSettingsModal
          open
          onClose={vi.fn()}
          session={leanSession}
          client={client}
          currentUser={null}
        />
      );
      const { rerender } = render(withConnection(1, modal));
      expect(await screen.findByText('(details unavailable)')).toBeInTheDocument();

      rerender(withConnection(2, modal));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByText('Advanced'));
      const field = (await screen.findByTestId('custom-context')) as HTMLTextAreaElement;
      await waitFor(() => expect(field.readOnly).toBe(false));
      expect(JSON.parse(field.value)).toEqual(fullContext);
    });

    it('seeds the collapsed editor when the full record arrives late', async () => {
      // Opened straight from a branch-card row: the panel was never opened.
      let resolve: (session: Session) => void = () => {};
      const get = vi.fn(
        () =>
          new Promise<Session>((done) => {
            resolve = done;
          })
      );
      render(
        <SessionSettingsModal
          open
          onClose={vi.fn()}
          session={leanSession}
          client={{ service: () => ({ get }) } as unknown as AgorClient}
          currentUser={null}
        />
      );
      expect(get).toHaveBeenCalledWith('s1');
      expect(screen.getByText('(loading…)')).toBeInTheDocument();
      resolve(fullSession);
      await waitFor(() => expect(screen.queryByText('(loading…)')).toBeNull());

      fireEvent.click(screen.getByText('Advanced'));
      const field = (await screen.findByTestId('custom-context')) as HTMLTextAreaElement;
      expect(field.readOnly).toBe(false);
      expect(JSON.parse(field.value)).toEqual(fullContext);
    });

    it('uses a full store row directly and keeps edits across a reconnect', async () => {
      const get = vi.fn();
      const client = { service: () => ({ get }) } as unknown as AgorClient;
      const props = { open: true, onClose: vi.fn(), currentUser: null, session: fullSession };
      const { rerender } = render(
        withConnection(1, <SessionSettingsModal {...props} client={client} />)
      );
      fireEvent.click(screen.getByText('Advanced'));
      const field = (await screen.findByTestId('custom-context')) as HTMLTextAreaElement;
      expect(field.readOnly).toBe(false);
      expect(JSON.parse(field.value)).toEqual(fullContext);

      fireEvent.change(field, { target: { value: '{"edited":true}' } });
      // Reconnect with a new client while the store row is downgraded to lean.
      rerender(
        withConnection(
          2,
          <SessionSettingsModal
            {...props}
            session={leanSession}
            client={{ service: () => ({ get }) } as unknown as AgorClient}
          />
        )
      );
      await new Promise((done) => setTimeout(done, 0));
      expect(get).not.toHaveBeenCalled();
      expect(field.value).toBe('{"edited":true}');
      expect(field.readOnly).toBe(false);
    });

    it('edits the full record, read-only until it loads', async () => {
      const onUpdate = vi.fn();
      let resolve: (session: Session) => void = () => {};
      const get = vi.fn(
        () =>
          new Promise<Session>((done) => {
            resolve = done;
          })
      );
      render(
        <SessionSettingsModal
          open
          onClose={vi.fn()}
          session={leanSession}
          client={{ service: () => ({ get }) } as unknown as AgorClient}
          currentUser={null}
          onUpdate={onUpdate}
        />
      );
      fireEvent.click(screen.getByText('Advanced'));
      const field = (await screen.findByTestId('custom-context')) as HTMLTextAreaElement;
      expect(field.readOnly).toBe(true);
      // The lean JSON in the read-only editor is labelled as incomplete.
      expect(screen.getByText('Loading full session context…')).toBeInTheDocument();

      resolve({ ...leanSession, custom_context: fullContext } as Session);
      await waitFor(() => expect(field.readOnly).toBe(false));
      expect(screen.queryByText('Loading full session context…')).toBeNull();
      expect(JSON.parse(field.value)).toEqual(fullContext);

      fireEvent.change(field, {
        target: { value: JSON.stringify({ ...fullContext, teamName: 'Frontend' }) },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(onUpdate).toHaveBeenCalled());
      // Only the edited key: untouched arrays (slash_commands) are not echoed.
      expect(onUpdate.mock.calls[0][1].custom_context).toEqual({ teamName: 'Frontend' });
    });
  });
});
