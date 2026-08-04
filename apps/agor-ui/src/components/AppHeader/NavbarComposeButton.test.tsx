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
  AgenticConfigChipRow: () => <div data-testid="config-chip-row" />,
}));

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
  render(
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
  return { onCreateSession };
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: 'Compose — ask your primary assistant' }));
}

describe('NavbarComposeButton', () => {
  beforeEach(() => {
    goToSession.mockClear();
  });

  it('opens the compose popover from the navbar trigger', async () => {
    renderCompose({ primary: primaryBranch });
    openPopover();
    expect(await screen.findByTestId('compose-prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send & Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send in Background' })).toBeInTheDocument();
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
