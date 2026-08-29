import type { AgorClient, Branch, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, Checkbox, Form } from 'antd';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCreationResult } from '../../domain/sessionCreation';
import { NavbarComposeButton } from './NavbarComposeButton';

const goToSession = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useAppNavigation', () => ({
  useAppNavigation: () => ({
    goToSession,
    goToBranch: vi.fn(),
    goToBoard: vi.fn(),
    goToArtifact: vi.fn(),
    goHome: vi.fn(),
  }),
}));

vi.mock('../../store/agorStore', () => ({
  useAgorStore: (selector: (state: unknown) => unknown) =>
    selector({
      mcpServerById: new Map(),
      userById: new Map(),
      agenticToolSettingsByName: new Map(),
    }),
}));

vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: ({
    tool,
    leadingField,
    branchId,
    validateModelSelection,
    onConfigValidityChange,
  }: {
    tool: string;
    leadingField?: React.ReactNode;
    branchId?: string;
    validateModelSelection?: boolean;
    onConfigValidityChange?: (valid: boolean, reason?: string) => void;
  }) => {
    useEffect(() => onConfigValidityChange?.(true), [onConfigValidityChange]);
    return (
      <div
        data-testid="config-chip-row"
        data-tool={tool}
        data-branch-id={branchId}
        data-validates-model={String(Boolean(validateModelSelection))}
      >
        {leadingField}
        <button
          type="button"
          data-testid="invalidate-config"
          onClick={() => onConfigValidityChange?.(false, 'Invalid configuration')}
        >
          invalidate
        </button>
        <Form.Item name="mcpServerIds" noStyle>
          <Checkbox.Group options={[{ label: 'Edited MCP', value: 'edited-mcp' }]} />
        </Form.Item>
      </div>
    );
  },
}));

vi.mock('../AgentSelectionGrid', () => ({
  AVAILABLE_AGENTS: [
    { id: 'claude-code', name: 'Claude Code', icon: '🤖' },
    { id: 'codex', name: 'Codex', icon: '💻' },
  ],
  AgentSelectionGrid: ({
    selectedAgentId,
    onSelect,
    variant,
  }: {
    selectedAgentId: string | null;
    onSelect: (id: string) => void;
    variant?: string;
  }) => (
    <div data-testid="agent-grid" data-selected={selectedAgentId ?? ''} data-variant={variant}>
      <button type="button" data-testid="pick-codex" onClick={() => onSelect('codex')}>
        codex
      </button>
    </div>
  ),
}));

// Passthrough drop zone that exposes a file-drop trigger.
vi.mock('../SessionPanel/SessionComposerDropZone', () => ({
  SessionComposerDropZone: ({
    children,
    onFilesDrop,
  }: {
    children: React.ReactNode;
    onFilesDrop: (files: File[]) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="drop-file"
        onClick={() => onFilesDrop([new File(['x'], 'shot.png', { type: 'image/png' })])}
      >
        drop
      </button>
      {children}
    </div>
  ),
}));

vi.mock('../SessionPanel/SessionAttachmentTray', () => ({
  SessionAttachmentTray: ({ attachments }: { attachments: unknown[] }) => (
    <div data-testid="attach-tray" data-count={attachments.length} />
  ),
}));

vi.mock('../SessionPanel/useComposerAttachments', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    useComposerAttachments: () => {
      const [attachments, setAttachments] = useState<{ id: string; file: File }[]>([]);
      return {
        attachments,
        addAttachments: (files: File[]) =>
          setAttachments((prev) => [...prev, ...files.map((file) => ({ id: file.name, file }))]),
        removeAttachment: (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
        clearAttachments: () => setAttachments([]),
      };
    },
  };
});

vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      data-testid="compose-prompt"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock('../AgenticToolConfigForm', () => ({
  buildConfigFromFormValues: () => ({ modelConfig: undefined }),
  getFormValuesFromConfig: () => ({}),
}));

vi.mock('../AgenticToolConfigurationPicker', () => ({
  INLINE_AGENTIC_CONFIGURATION: '__inline__',
}));

vi.mock('../AgenticToolConfigurationPicker/useAgenticConfigurationSources', () => ({
  getUserAgenticToolDefault: () => ({ configuration: {} }),
  getUserDefaultConfigurationSource: () => 'default',
}));

// The Settings picker is reused verbatim in the null-primary case; here it just
// needs to surface an `onPicked` trigger so we can assert the send resumes.
vi.mock('../SettingsModal/PrimaryTeammatePicker', () => ({
  PrimaryTeammatePicker: ({ onPicked }: { onPicked?: (branch: Branch) => void }) => (
    <button type="button" data-testid="pick-teammate" onClick={() => onPicked?.(pickedBranch)}>
      pick
    </button>
  ),
}));

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-primary',
    name: 'ada',
    board_id: 'board-primary',
    custom_context: { teammate: { kind: 'teammate', displayName: 'Ada' } },
    ...overrides,
  } as unknown as Branch;
}

const primaryBranch = makeBranch();
const pickedBranch = makeBranch({
  branch_id: 'branch-picked',
  board_id: 'board-primary',
  mcp_server_ids: ['picked-mcp'],
});

function makeClient(primary: Branch | null): AgorClient {
  return {
    service: () => ({ getPrimaryTeammate: () => Promise.resolve(primary) }),
  } as unknown as AgorClient;
}

function renderCompose(opts: {
  primary: Branch | null;
  currentBoardId?: string;
  pathname?: string;
  currentUser?: User | null;
  authenticationGeneration?: number;
  isAuthenticationGenerationCurrent?: (generation: number) => boolean;
  disabled?: boolean;
  onCreateSession?: (config: unknown, boardId: string) => Promise<SessionCreationResult | null>;
}) {
  const onCreateSession =
    opts.onCreateSession ??
    vi.fn().mockResolvedValue({
      sessionId: 'session-new',
    });
  const client = makeClient(opts.primary);
  const renderElement = (renderOpts: typeof opts) => (
    <MemoryRouter initialEntries={[renderOpts.pathname ?? '/b/x/']}>
      <AntApp>
        <NavbarComposeButton
          client={client}
          currentUser={renderOpts.currentUser ?? null}
          authenticationGeneration={renderOpts.authenticationGeneration ?? 0}
          isAuthenticationGenerationCurrent={renderOpts.isAuthenticationGenerationCurrent}
          currentBoardId={renderOpts.currentBoardId ?? 'board-current'}
          onCreateSession={onCreateSession as never}
          disabled={renderOpts.disabled}
        />
      </AntApp>
    </MemoryRouter>
  );
  const result = render(renderElement(opts));
  return {
    onCreateSession,
    ...result,
    rerenderCompose: (updates: Partial<typeof opts>) =>
      result.rerender(renderElement({ ...opts, ...updates })),
  };
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: 'Compose — ask your primary assistant' }));
}

describe('NavbarComposeButton', () => {
  beforeEach(() => {
    goToSession.mockClear();
    localStorage.clear();
  });

  it('shows the resolved primary teammate emoji on the collapsed trigger before opening', async () => {
    const withEmoji = makeBranch({
      custom_context: { teammate: { kind: 'teammate', displayName: 'Ada', emoji: '🎨' } },
    });
    renderCompose({ primary: withEmoji });
    // Resolved eagerly on mount — no popover open needed.
    expect(await screen.findByText('🎨')).toBeInTheDocument();
  });

  it('shows the 🤖 placeholder emoji on the trigger when no primary is set', async () => {
    renderCompose({ primary: null });
    expect(await screen.findByText('🤖')).toBeInTheDocument();
  });

  it('shows a "Start quick session" tooltip on the trigger', async () => {
    renderCompose({ primary: primaryBranch });
    fireEvent.mouseEnter(
      screen.getByRole('button', { name: 'Compose — ask your primary assistant' })
    );
    expect(await screen.findByText('Start quick session')).toBeInTheDocument();
  });

  it('opens the compose popover with a heading and prompt', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    expect(await screen.findByTestId('compose-prompt')).toBeInTheDocument();
    expect(screen.getByText(/your primary assistant/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send & Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send in Background' })).toBeInTheDocument();
  });

  it('merges the resolved primary name into the header line', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    await screen.findByTestId('compose-prompt');
    expect(screen.getByText(/your primary assistant/i)).toHaveTextContent(
      'Ask Ada, your primary assistant'
    );
  });

  it('explains the null-primary state above the inline picker (no name in header)', async () => {
    renderCompose({ primary: null });
    openPopover();
    expect(await screen.findByTestId('pick-teammate')).toBeInTheDocument();
    // No resolved name yet, so the header stays generic (no broken/empty identity).
    expect(screen.getByText('Ask your primary assistant')).toBeInTheDocument();
    expect(screen.getByText(/don't have a primary assistant yet/i)).toBeInTheDocument();
    expect(screen.getByText(/default teammate for personal, ambient work/i)).toBeInTheDocument();
    expect(screen.getByText(/change it anytime in Settings/i)).toBeInTheDocument();
  });

  it('shows the first-time hint once, then never again after dismissal', async () => {
    const { unmount } = renderCompose({ primary: primaryBranch });
    openPopover();
    expect(await screen.findByText(/Ask for anything/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByText(/Ask for anything/i)).not.toBeInTheDocument();

    // Remount fresh: the dismissal persisted, so the hint stays gone.
    unmount();
    renderCompose({ primary: primaryBranch });
    openPopover();
    await screen.findByTestId('compose-prompt');
    expect(screen.queryByText(/Ask for anything/i)).not.toBeInTheDocument();
  });

  it('routes the picked tool into the chip row and the created session', async () => {
    const { onCreateSession } = renderCompose({
      primary: primaryBranch,
      currentBoardId: 'board-current',
    });
    openPopover();
    await screen.findByTestId('compose-prompt');
    expect(screen.getByTestId('config-chip-row')).toHaveAttribute('data-tool', 'claude-code');

    fireEvent.click(screen.getByTestId('pick-codex'));
    expect(screen.getByTestId('config-chip-row')).toHaveAttribute('data-tool', 'codex');

    fireEvent.change(screen.getByTestId('compose-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({ agent: 'codex' });
  });

  it('opens on the user primary coding agent', async () => {
    renderCompose({
      primary: primaryBranch,
      currentUser: { primary_agentic_tool: 'codex' } as User,
    });

    openPopover();

    expect(await screen.findByTestId('agent-grid')).toHaveAttribute('data-selected', 'codex');
    expect(screen.getByTestId('config-chip-row')).toHaveAttribute('data-tool', 'codex');
  });

  it('renders the agent picker as the compact select variant, co-located with the config row', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    const agentGrid = await screen.findByTestId('agent-grid');
    expect(agentGrid).toHaveAttribute('data-variant', 'select');
    // Agent field lives in the config row's leadingField slot (side-by-side layout).
    expect(screen.getByTestId('config-chip-row')).toContainElement(agentGrid);
  });

  it('validates configuration for the resolved primary branch and blocks invalid submission', async () => {
    const { onCreateSession } = renderCompose({ primary: primaryBranch });
    openPopover();
    const config = await screen.findByTestId('config-chip-row');
    expect(config).toHaveAttribute('data-branch-id', 'branch-primary');
    expect(config).toHaveAttribute('data-validates-model', 'true');

    fireEvent.change(screen.getByTestId('compose-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByTestId('invalidate-config'));
    expect(screen.getByRole('button', { name: 'Send & Open' })).toBeDisabled();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('inherits MCP servers from the primary branch before user defaults', async () => {
    const branch = makeBranch({ mcp_server_ids: ['branch-mcp'] });
    const user = { default_mcp_server_ids: ['user-mcp'] } as unknown as User;
    const { onCreateSession } = renderCompose({ primary: branch, currentUser: user });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({ mcpServerIds: ['branch-mcp'] });
  });

  it('gives both send buttons an explanatory tooltip', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    // Enable the buttons first; AntD tooltips don't fire on disabled controls.
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'hi' } });

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send & Open' }));
    expect(await screen.findByText(/takes you there now, on Ada's board/)).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Send in Background' }));
    expect(await screen.findByText(/in the background, on Ada's board/)).toBeInTheDocument();
  });

  it('lets a dropped file be sent even with an empty prompt', async () => {
    const { onCreateSession } = renderCompose({
      primary: primaryBranch,
      currentBoardId: 'board-current',
    });
    openPopover();
    await screen.findByTestId('compose-prompt');
    expect(screen.getByTestId('attach-tray')).toHaveAttribute('data-count', '0');
    // Empty prompt + no attachment → send is blocked.
    expect(screen.getByRole('button', { name: 'Send & Open' })).toBeDisabled();

    fireEvent.click(screen.getByTestId('drop-file'));
    expect(screen.getByTestId('attach-tray')).toHaveAttribute('data-count', '1');

    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0][0].attachmentFiles).toHaveLength(1);
  });

  it('keeps the navbar trigger neutral (not primary) while Send & Open stays primary', async () => {
    renderCompose({ primary: primaryBranch });
    // The collapsed trigger is a calm default button, not a loud primary CTA.
    expect(
      screen.getByRole('button', { name: 'Compose — ask your primary assistant' })
    ).not.toHaveClass('ant-btn-primary');

    openPopover();
    await screen.findByTestId('compose-prompt');
    expect(screen.getByRole('button', { name: 'Send & Open' })).toHaveClass('ant-btn-primary');
    expect(screen.getByRole('button', { name: 'Send in Background' })).not.toHaveClass(
      'ant-btn-primary'
    );
  });

  it('Send & Open navigates to the new session when on a non-primary board', async () => {
    const { onCreateSession } = renderCompose({
      primary: primaryBranch,
      currentBoardId: 'board-current',
    });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'hi Ada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({
      branch_id: 'branch-primary',
      initialPrompt: 'hi Ada',
    });
    await waitFor(() => expect(goToSession).toHaveBeenCalledWith('session-new'));
  });

  it.each([
    ['a different caller', { user_id: 'user-b' }, 2],
    ['the same caller in a new auth session', { user_id: 'user-a' }, 2],
  ])(
    'does not navigate when creation settles after %s takes ownership',
    async (_case, nextUser, nextGeneration) => {
      let liveAuthenticationGeneration = 1;
      let resolveCreation: ((result: SessionCreationResult) => void) | undefined;
      const onCreateSession = vi.fn(
        () =>
          new Promise<SessionCreationResult>((resolve) => {
            resolveCreation = resolve;
          })
      );
      const { rerenderCompose } = renderCompose({
        primary: primaryBranch,
        currentUser: { user_id: 'user-a' } as User,
        authenticationGeneration: 1,
        isAuthenticationGenerationCurrent: (generation) =>
          generation === liveAuthenticationGeneration,
        onCreateSession,
      });
      openPopover();
      fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'slow' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));
      await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));

      liveAuthenticationGeneration = nextGeneration;
      rerenderCompose({
        currentUser: nextUser as User,
        authenticationGeneration: nextGeneration,
      });
      resolveCreation?.({ sessionId: 'session-stale' });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(goToSession).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['home', '/'],
    ['Knowledge', '/knowledge'],
  ])('Send & Open navigates directly from the %s surface', async (_surface, pathname) => {
    renderCompose({ primary: primaryBranch, currentBoardId: '', pathname });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));

    await waitFor(() => expect(goToSession).toHaveBeenCalledWith('session-new'));
    expect(screen.queryByText('Session started')).not.toBeInTheDocument();
  });

  it('Send in Background never navigates (board surface)', async () => {
    const { onCreateSession } = renderCompose({
      primary: primaryBranch,
      currentBoardId: 'board-current',
    });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'bg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send in Background' }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(goToSession).not.toHaveBeenCalled();
    expect(screen.queryByText('Session started')).not.toBeInTheDocument();
  });

  it('Send in Background never navigates (non-board surface)', async () => {
    const { onCreateSession } = renderCompose({
      primary: primaryBranch,
      currentBoardId: '',
      pathname: '/knowledge',
    });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'bg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send in Background' }));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(goToSession).not.toHaveBeenCalled();
    expect(screen.queryByText('Session started')).not.toBeInTheDocument();
  });

  it('disables the compose mutation surface while the connection is unavailable', () => {
    renderCompose({ primary: primaryBranch, disabled: true });
    expect(
      screen.getByRole('button', { name: 'Compose — ask your primary assistant' })
    ).toBeDisabled();
  });

  it('shows the inline picker for a null primary and resumes the send with the typed prompt', async () => {
    const { onCreateSession } = renderCompose({ primary: null, currentBoardId: 'board-current' });
    openPopover();

    // Type first, then discover no primary is set — the prompt must survive.
    fireEvent.change(await screen.findByTestId('compose-prompt'), {
      target: { value: 'keep me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));
    // Nothing created yet — we're waiting on a teammate pick.
    expect(onCreateSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('pick-teammate'));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({
      branch_id: 'branch-picked',
      initialPrompt: 'keep me',
      mcpServerIds: ['picked-mcp'],
    });
    await waitFor(() => expect(goToSession).toHaveBeenCalledWith('session-new'));
  });

  it('does not overwrite MCP edits made before choosing a primary assistant', async () => {
    const { onCreateSession } = renderCompose({ primary: null });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Edited MCP' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));
    fireEvent.click(screen.getByTestId('pick-teammate'));

    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({ mcpServerIds: ['edited-mcp'] });
  });
});
