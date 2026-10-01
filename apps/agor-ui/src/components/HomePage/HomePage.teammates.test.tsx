import type { AgorClient, Board, User } from '@agor-live/client';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asDesktop,
  comment,
  renderHome,
  resetHome,
  seed,
  session,
  teammate,
  user,
} from './testUtils';

// The side rail mounts at once.
vi.mock('../../hooks/useIdleReady', () => ({ useIdleReady: () => true }));

beforeEach(resetHome);

describe('HomePage teammates', () => {
  const primary = teammate('primary', 'b-primary');
  const client = (can: Record<string, string>) =>
    ({
      service: (name: string) =>
        name === 'branches/:id/effective-access'
          ? {
              find: async ({ route }: { route: { id: string } }) => ({
                can: can[route.id] ?? 'view',
                is_owner: false,
                source: 'others',
              }),
            }
          : { getPrimaryTeammate: async () => primary, find: async () => [] },
    }) as unknown as AgorClient;
  const seedTeammates = () =>
    seed({
      sessions: [session('idle')],
      branches: [primary, teammate('t', 'b'), teammate('v', 'b-view')],
      boards: [
        { board_id: 'b-primary', name: 'Teammate primary', archived: false } as Board,
        { board_id: 'b', name: 'Board B', archived: false } as Board,
        { board_id: 'b-view', name: 'Board V', archived: false } as Board,
      ],
    });

  it('opens a teammate’s board from its card and marks view-only access', async () => {
    seedTeammates();
    const onBoardClick = vi.fn();
    renderHome({ client: client({ t: 'session' }), onBoardClick });
    expect(await screen.findAllByText(/View only · ask/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Teammate t, open Board B' }));
    expect(onBoardClick).toHaveBeenCalledWith('b');
  });

  it('opens the directory through the shell’s "See all", and hides the link without one', async () => {
    seedTeammates();
    const onSeeAllTeammates = vi.fn();
    const { unmount } = renderHome({ client: client({}), onSeeAllTeammates });
    fireEvent.click(await screen.findByRole('button', { name: 'See all 3' }));
    expect(onSeeAllTeammates).toHaveBeenCalledOnce();
    unmount();

    renderHome({ client: client({}) });
    await screen.findByText('Teammate t');
    expect(screen.queryByRole('button', { name: /^See all \d/ })).not.toBeInTheDocument();
  });

  it('offers a quiet retry when a teammate’s access read fails', async () => {
    seedTeammates();
    let down = true;
    const flaky = client({ t: 'session' });
    const service = flaky.service.bind(flaky);
    flaky.service = ((name: string) => {
      const real = service(name as never) as { find: (params: unknown) => Promise<unknown> };
      if (name !== 'branches/:id/effective-access') return real;
      return {
        find: (params: { route: { id: string } }) =>
          down && params.route.id === 'v' ? Promise.reject(new Error('down')) : real.find(params),
      };
    }) as never;
    renderHome({ client: flaky });
    const rail = await screen.findByRole('region', { name: 'AI teammates' });
    expect(await within(rail).findByText(/Couldn’t check access/)).toBeInTheDocument();
    down = false;
    fireEvent.click(within(rail).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(rail).queryByText(/Couldn’t check access/)).toBeNull());
    expect(within(rail).getAllByText(/View only · ask/)).toHaveLength(2);
  });

  it('asks the primary by default, sends to a teammate picked from the phone sheet, then resets', async () => {
    seedTeammates();
    const onCreateSession = vi.fn(async () => ({ sessionId: 'new' }));
    renderHome({ client: client({ t: 'session' }), onCreateSession });
    await screen.findByRole('textbox', { name: 'Ask Teammate primary' });

    fireEvent.click(screen.getByRole('button', { name: 'Teammate to ask: Teammate primary' }));
    const sheet = await screen.findByRole('dialog', { name: 'Ask' });
    await within(sheet).findByText('Teammate t');
    expect(within(sheet).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(sheet).queryByText('Teammate v')).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Teammate t' }));

    const input = await screen.findByRole('textbox', { name: 'Ask Teammate t' });
    fireEvent.change(input, { target: { value: 'Status please' } });
    fireEvent.click(screen.getByRole('button', { name: /^Send( in background)?$/ }));
    await waitFor(() => expect(onCreateSession).toHaveBeenCalled());
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({ branch_id: 't' });
    expect(
      await screen.findByRole('textbox', { name: 'Ask Teammate primary' })
    ).toBeInTheDocument();
  });

  it('keeps a draft typed while a send is in flight', async () => {
    seedTeammates();
    let finish!: (result: { sessionId: string }) => void;
    const onCreateSession = vi.fn(
      () => new Promise<{ sessionId: string }>((resolve) => (finish = resolve))
    );
    renderHome({ client: client({}), onCreateSession });
    const input = await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    fireEvent.change(input, { target: { value: 'First question' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'Next draft' } });
    await act(async () => finish({ sessionId: 'new' }));
    expect(input).toHaveValue('Next draft');
  });

  it('sends on Enter, adds a line on Shift+Enter, and opens on Ctrl+Enter', async () => {
    seedTeammates();
    const onCreateSession = vi.fn(async () => ({ sessionId: 'new' }));
    const onSessionClick = vi.fn();
    renderHome({ client: client({}), onCreateSession, onSessionClick });
    const input = await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    fireEvent.change(input, { target: { value: 'First line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onCreateSession).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onCreateSession).toHaveBeenCalledTimes(1));
    expect(onSessionClick).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Open this one' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSessionClick).toHaveBeenCalledWith('new'));
  });

  it('sends from one split button on phones, with Send & open in its menu', async () => {
    seedTeammates();
    const onCreateSession = vi.fn(async () => ({ sessionId: 'new' }));
    const onSessionClick = vi.fn();
    renderHome({ client: client({}), onCreateSession, onSessionClick });
    const input = await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    const toolbar = document.querySelector<HTMLElement>('[data-home-ask-toolbar]') as HTMLElement;
    expect(within(toolbar).getByRole('button', { name: 'Send in background' })).toBeInTheDocument();
    expect(within(toolbar).queryByRole('button', { name: 'Send & open' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Open it' } });
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More send options' }));
    fireEvent.click(await screen.findByText('Send & open'));
    await waitFor(() => expect(onSessionClick).toHaveBeenCalledWith('new'));
  });

  it('puts both send buttons in the toolbar on desktop, primary last', async () => {
    asDesktop();
    seedTeammates();
    renderHome({ client: client({}) });
    await screen.findByRole('textbox', { name: 'Ask Teammate primary' });
    const toolbar = document.querySelector<HTMLElement>('[data-home-ask-toolbar]') as HTMLElement;
    const names = within(toolbar)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names.slice(-2)).toEqual(['Send & open', 'Send in background']);
  });

  it('searches on desktop, one line per teammate, with the board only when it says more', async () => {
    asDesktop();
    seedTeammates();
    renderHome({ client: client({ t: 'session' }) });
    const picker = await screen.findByRole('combobox', { name: 'Teammate to ask' });
    expect(picker).not.toHaveAttribute('readonly');
    fireEvent.mouseDown(picker);
    const popup = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.ant-select-dropdown');
      expect(found && within(found).queryByText('Teammate t')).toBeTruthy();
      return found as HTMLElement;
    });
    expect(within(popup).getByText('📋 Board B')).toBeInTheDocument();
    expect(within(popup).queryByText(/Board primary/)).not.toBeInTheDocument();
  });

  it('says the picker is still checking, not empty, while access reads are out', async () => {
    seedTeammates();
    const answers: (() => void)[] = [];
    const pending = {
      service: (name: string) =>
        name === 'branches/:id/effective-access'
          ? {
              find: () =>
                new Promise((resolve) =>
                  answers.push(() => resolve({ can: 'view', is_owner: false, source: 'others' }))
                ),
            }
          : { getPrimaryTeammate: async () => null, find: async () => [] },
    } as unknown as AgorClient;
    renderHome({ client: pending });
    fireEvent.click(await screen.findByRole('button', { name: 'Pick an assistant' }));
    const sheet = await screen.findByRole('dialog', { name: 'Ask' });
    expect(within(sheet).getByText('Checking which teammates you can ask…')).toBeInTheDocument();
    await waitFor(() => expect(answers).toHaveLength(3));
    await act(async () => {
      for (const answer of answers) answer();
    });
    expect(await within(sheet).findByText('No teammates you can ask')).toBeInTheDocument();
  });

  it('asks to pick an assistant when there is no primary', async () => {
    seedTeammates();
    const none = {
      service: () => ({ getPrimaryTeammate: async () => null, find: async () => [] }),
    } as unknown as AgorClient;
    renderHome({ client: none });
    expect(await screen.findByRole('button', { name: 'Pick an assistant' })).toBeInTheDocument();
  });
});

describe('HomePage privacy for superadmins', () => {
  const superadmin = { ...user, role: 'superadmin' } as User;
  const policyClient = (sharing: Record<string, 'shared' | 'private'>) =>
    ({
      service: (name: string) =>
        name === 'boards/:id/permissions'
          ? {
              find: async ({ route }: { route: { id: string } }) => ({
                primary_owner_user_id: 'owner-1',
                board_access: {
                  policy_kind: 'board_access',
                  sharing_mode: sharing[route.id],
                  entries: [],
                  others: {
                    preset: 'viewer',
                    capabilities: sharing[route.id] === 'shared' ? ['board.view'] : [],
                    fs_access: 'none',
                  },
                },
              }),
            }
          : name === 'group-memberships' || name === 'groups'
            ? { findAll: async () => [] }
            : {
                getPrimaryTeammate: async () => null,
                find: async () => ({ can: 'view' }),
                get: () => new Promise(() => {}),
              },
    }) as unknown as AgorClient;

  it('never lists teammates or comments from boards private to others', async () => {
    seed({
      sessions: [session('idle')],
      comments: [
        comment('shared-c', { board_id: 'b-shared' }),
        comment('private-c', { board_id: 'b-private', content: '@"Kasia Designer" secret' }),
      ],
      branches: [teammate('open', 'b-shared'), teammate('hidden', 'b-private')],
      boards: [
        { board_id: 'b-shared', name: 'S', archived: false } as Board,
        { board_id: 'b-private', name: 'P', archived: false } as Board,
      ],
    });
    renderHome({
      currentUser: superadmin,
      client: policyClient({ 'b-shared': 'shared', 'b-private': 'private' }),
    });
    expect(await screen.findByText('Teammate open')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /can you look/ })).toBeInTheDocument();
    expect(screen.queryByText('Teammate hidden')).not.toBeInTheDocument();
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it('keeps the rail and its retry link mounted while a failed policy read is retried', async () => {
    seed({
      sessions: [session('idle')],
      branches: [teammate('open', 'b-shared')],
      boards: [{ board_id: 'b-shared', name: 'S', archived: false } as Board],
    });
    const real = policyClient({ 'b-shared': 'shared' });
    const answers: { settle: (fail: boolean) => void }[] = [];
    const flaky = {
      service: (name: string) => {
        const service = real.service(name as never) as { find: (p: unknown) => Promise<unknown> };
        if (name !== 'boards/:id/permissions') return service;
        return {
          find: (params: unknown) =>
            new Promise((resolve, reject) =>
              answers.push({
                settle: (fail) =>
                  fail ? reject(new Error('down')) : service.find(params).then(resolve),
              })
            ),
        };
      },
    } as unknown as AgorClient;
    renderHome({ currentUser: superadmin, client: flaky, onSeeAllTeammates: () => {} });
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => answers[0].settle(true));
    const rail = await screen.findByRole('region', { name: 'AI teammates' });
    // No "See all 0" beside the failure notice.
    expect(within(rail).queryByRole('button', { name: /^See all/ })).not.toBeInTheDocument();
    const retry = within(rail).getByRole('button', { name: 'Try again' });
    retry.focus();

    fireEvent.click(retry);
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(screen.getByRole('region', { name: 'AI teammates' })).toBe(rail);
    expect(within(rail).getByRole('button', { name: /Try again/ })).toBe(document.activeElement);

    await act(async () => answers[1].settle(false));
    expect(await within(rail).findByText('Teammate open')).toBeInTheDocument();
    expect(within(rail).queryByText(/Couldn’t check access/)).not.toBeInTheDocument();
    expect(within(rail).getByRole('button', { name: 'See all 1' })).toBeInTheDocument();
  });
});
