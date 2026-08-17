import type { AgorClient, Branch } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      boardById: new Map([['board-primary', { board_id: 'board-primary', name: 'Ada Board' }]]),
      mcpServerById: new Map(),
      userById: new Map(),
    }),
}));

vi.mock('../AgenticConfigChipRow', () => ({
  AgenticConfigChipRow: ({
    tool,
    leadingField,
  }: {
    tool: string;
    leadingField?: React.ReactNode;
  }) => (
    <div data-testid="config-chip-row" data-tool={tool}>
      {leadingField}
    </div>
  ),
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
const pickedBranch = makeBranch({ branch_id: 'branch-picked', board_id: 'board-primary' });

function makeClient(primary: Branch | null): AgorClient {
  return {
    service: () => ({ getPrimaryTeammate: () => Promise.resolve(primary) }),
  } as unknown as AgorClient;
}

function renderCompose(opts: {
  primary: Branch | null;
  currentBoardId?: string;
  pathname?: string;
  onCreateSession?: (config: unknown, boardId: string) => Promise<string | null>;
}) {
  const onCreateSession = opts.onCreateSession ?? vi.fn().mockResolvedValue('session-new');
  const result = render(
    <MemoryRouter initialEntries={[opts.pathname ?? '/b/x/']}>
      <AntApp>
        <NavbarComposeButton
          client={makeClient(opts.primary)}
          currentUser={null}
          currentBoardId={opts.currentBoardId ?? 'board-current'}
          onCreateSession={onCreateSession as never}
        />
      </AntApp>
    </MemoryRouter>
  );
  return { onCreateSession, ...result };
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: 'Compose — ask your primary assistant' }));
}

describe('NavbarComposeButton', () => {
  beforeEach(() => {
    goToSession.mockClear();
    localStorage.clear();
  });

  it('opens the compose popover with a heading and prompt', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    expect(await screen.findByTestId('compose-prompt')).toBeInTheDocument();
    expect(screen.getByText('Ask your primary assistant')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send & Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send in Background' })).toBeInTheDocument();
  });

  it('explains the null-primary state above the inline picker', async () => {
    renderCompose({ primary: null });
    openPopover();
    expect(await screen.findByTestId('pick-teammate')).toBeInTheDocument();
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

  it('renders the agent picker as the compact select variant, co-located with the config row', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    const agentGrid = await screen.findByTestId('agent-grid');
    expect(agentGrid).toHaveAttribute('data-variant', 'select');
    // Agent field lives in the config row's leadingField slot (side-by-side layout).
    expect(screen.getByTestId('config-chip-row')).toContainElement(agentGrid);
  });

  it('shows the resolved primary as a tag once resolved', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    await screen.findByTestId('compose-prompt');
    // The tag renders the bare teammate name; the wayfinding sentence embeds it in prose.
    expect(screen.getByText('Ada')).toBeInTheDocument();
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

  it('gives the trigger and Send & Open primary weight, Send in Background secondary', async () => {
    renderCompose({ primary: primaryBranch });
    expect(
      screen.getByRole('button', { name: 'Compose — ask your primary assistant' })
    ).toHaveClass('ant-btn-primary');

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

  it('Send & Open on a non-board surface shows an in-place panel instead of navigating', async () => {
    renderCompose({ primary: primaryBranch, currentBoardId: '', pathname: '/knowledge' });
    openPopover();
    fireEvent.change(await screen.findByTestId('compose-prompt'), { target: { value: 'ping' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send & Open' }));

    // The in-place panel appears; no navigation happens until "Open on board".
    expect(await screen.findByText('Session started')).toBeInTheDocument();
    expect(goToSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open on board' }));
    expect(goToSession).toHaveBeenCalledWith('session-new');
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
    });
    await waitFor(() => expect(goToSession).toHaveBeenCalledWith('session-new'));
  });
});
