import {
  type AgorClient,
  type Board,
  EXAMPLE_BOARD_OWNER_EMAIL,
  type User,
} from '@agor-live/client';
import { render, screen, waitFor, within } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type ExampleBoardActions, ExampleBoardProvider } from '../../contexts/ExampleBoardContext';
import { useExampleBoardController } from '../../hooks/useExampleBoardController';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardSwitcher } from '../BoardSwitcher';
import { ExampleBoardBanner, ExampleSessionFooter } from './ExampleBoard';

vi.mock('../BoardEditModal', () => ({ BoardEditModal: () => null }));

const EXAMPLES = 'user-examples';
const me = { user_id: 'me', email: 'me@example.test', preferences: {} } as User;
const exampleBoard = { board_id: 'example', name: "Wendy's board", created_by: EXAMPLES } as Board;
const ownBoard = { board_id: 'own', name: 'My board', created_by: 'me' } as Board;

const actions = (overrides: Partial<ExampleBoardActions> = {}): ExampleBoardActions => ({
  hidden: false,
  hide: vi.fn(),
  makeYourOwn: vi.fn(),
  ...overrides,
});

const seedStore = () =>
  agorStore.setState({
    ...EMPTY_MAPS,
    userById: new Map([
      ['me', me],
      [EXAMPLES, { user_id: EXAMPLES, email: EXAMPLE_BOARD_OWNER_EMAIL } as User],
    ]),
    boardById: new Map([
      [exampleBoard.board_id, exampleBoard],
      [ownBoard.board_id, ownBoard],
    ]),
  } as never);

afterEach(() => agorStore.setState({ ...EMPTY_MAPS } as never));

describe('example board banner and footer', () => {
  it('shows the exact copy and routes both actions', async () => {
    const value = actions();
    render(
      <ExampleBoardProvider value={value}>
        <ExampleBoardBanner boardId="example" />
        <ExampleSessionFooter sessionId="s1" />
      </ExampleBoardProvider>
    );

    expect(
      screen.getByText(
        'This is an example board with made-up data. Look around, nothing here runs.'
      )
    ).toBeVisible();
    expect(screen.getByText('Example session. Start your own to try this.')).toBeVisible();

    const [bannerMake, footerMake] = screen.getAllByRole('button', { name: 'Make your own' });
    await userEvent.click(bannerMake);
    await userEvent.click(footerMake);
    expect(value.makeYourOwn).toHaveBeenNthCalledWith(1, 'banner');
    expect(value.makeYourOwn).toHaveBeenNthCalledWith(2, 'session');

    await userEvent.click(screen.getByRole('button', { name: 'Hide example' }));
    expect(value.hide).toHaveBeenCalledOnce();
  });

  it('offers no Make your own to people who cannot start one', () => {
    render(
      <ExampleBoardProvider value={actions({ makeYourOwn: undefined })}>
        <ExampleBoardBanner boardId="example" />
        <ExampleSessionFooter sessionId="s1" />
      </ExampleBoardProvider>
    );
    expect(screen.queryByRole('button', { name: 'Make your own' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide example' })).toBeVisible();
  });
});

describe('board switcher', () => {
  const renderSwitcher = (hidden: boolean) => {
    seedStore();
    return render(
      <ExampleBoardProvider value={actions({ hidden })}>
        <BoardSwitcher
          boards={[exampleBoard, ownBoard]}
          currentBoardId="example"
          onBoardChange={vi.fn()}
          branchById={new Map()}
        />
      </ExampleBoardProvider>
    );
  };

  it('tags the example board', async () => {
    const { container } = renderSwitcher(false);
    expect(screen.getByText('Example')).toBeVisible();
    await userEvent.click(container.querySelector('button.ant-dropdown-trigger')!);
    const items = await screen.findAllByRole('menuitem');
    expect(items.find((item) => item.textContent?.includes("Wendy's board"))).toHaveTextContent(
      'Example'
    );
  });

  it('leaves the example out once the person hid it', async () => {
    const { container } = renderSwitcher(true);
    await userEvent.click(container.querySelector('button.ant-dropdown-trigger')!);
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('My board');
  });
});

describe('useExampleBoardController', () => {
  const Harness = ({
    client,
    openOnboarding,
  }: {
    client: AgorClient;
    openOnboarding?: () => void;
  }) => {
    const value = useExampleBoardController({ client, user: me, isMobile: true, openOnboarding });
    const location = useLocation();
    return (
      <ExampleBoardProvider value={value}>
        <output aria-label="path">{location.pathname}</output>
        <ExampleBoardBanner boardId="example" />
      </ExampleBoardProvider>
    );
  };

  const renderController = (client: AgorClient, openOnboarding = vi.fn()) => {
    seedStore();
    render(
      <AntApp>
        <MemoryRouter initialEntries={['/m/board/example']}>
          <Routes>
            <Route path="*" element={<Harness client={client} openOnboarding={openOnboarding} />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    );
    return openOnboarding;
  };

  const fakeClient = (primaryTeammate: unknown) => {
    const users = {
      get: vi.fn(async () => me),
      patch: vi.fn(async () => me),
      getPrimaryTeammate: vi.fn(async () => primaryTeammate),
    };
    return { client: { service: () => users } as unknown as AgorClient, users };
  };

  it('opens onboarding for someone without a teammate', async () => {
    const { client } = fakeClient(null);
    const openOnboarding = renderController(client);
    await userEvent.click(screen.getByRole('button', { name: 'Make your own' }));
    await waitFor(() => expect(openOnboarding).toHaveBeenCalledOnce());
  });

  it("goes to the person's own teammate board when they have one", async () => {
    const { client } = fakeClient({ branch_id: 'ada', board_id: 'own' });
    const openOnboarding = renderController(client);
    await userEvent.click(screen.getByRole('button', { name: 'Make your own' }));
    await waitFor(() => expect(screen.getByLabelText('path')).toHaveTextContent('/m/board/own'));
    expect(openOnboarding).not.toHaveBeenCalled();
  });

  it('hides for this person after confirming, and undo brings it back', async () => {
    const { client, users } = fakeClient(null);
    renderController(client);
    await userEvent.click(screen.getByRole('button', { name: 'Hide example' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('It will be hidden only for you. Nothing is deleted.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hide example' }));

    await waitFor(() =>
      expect(users.patch).toHaveBeenCalledWith('me', {
        preferences: { exampleBoardHidden: true },
      })
    );
    await waitFor(() => expect(screen.getByLabelText('path')).toHaveTextContent('/m/board/own'));

    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(users.patch).toHaveBeenLastCalledWith('me', {
        preferences: { exampleBoardHidden: false },
      })
    );
    await waitFor(() =>
      expect(screen.getByLabelText('path')).toHaveTextContent('/m/board/example')
    );
  });
});
