import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from 'antd';
import { beforeEach, expect, it, vi } from 'vitest';
import '../../index.css';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { BoardTeammatePanel } from './BoardTeammatePanel';

const branch = {
  branch_id: 'teammate-1',
  repo_id: 'repo-1',
  name: 'Teammate',
  filesystem_status: 'ready',
} as Branch;

beforeEach(() => {
  localStorage.clear();
  agorStore.setState({ ...EMPTY_MAPS });
});

function makeSessions(count = 1001, gateway = false): Session[] {
  const sessions = Array.from(
    { length: count },
    (_, index): Session => ({
      session_id: `session-${index}` as Session['session_id'],
      branch_id: branch.branch_id,
      title: `Conversation ${index}`,
      agentic_tool: 'codex',
      status: 'idle',
      archived: false,
      created_by: 'user-1',
      unix_username: null,
      sdk_home_scope: 'branch',
      url: null,
      contextFiles: [],
      tasks: [],
      scheduled_from_branch: false,
      ready_for_prompt: true,
      created_at: '2026-09-01T00:00:00.000Z',
      last_updated: new Date(Date.UTC(2026, 8, 1) - index * 1000).toISOString(),
      genealogy: {
        children: [],
        ...(index > 0 ? { parent_session_id: 'session-0' as Session['session_id'] } : {}),
      },
      ...(gateway && index === 0
        ? {
            custom_context: {
              gateway_source: {
                channel_id: 'channel-1',
                channel_type: 'slack',
                channel_name: 'Team',
                thread_id: 'thread-1',
              },
            },
          }
        : {}),
    })
  );
  return sessions;
}

function makeGatewaySessions(count: number): Session[] {
  return makeSessions(count, true).map((session, index) => ({
    ...session,
    session_id: `gateway-${index}` as Session['session_id'],
    genealogy: {
      children: [],
      ...(index > 0 ? { parent_session_id: 'gateway-0' as Session['session_id'] } : {}),
    },
  }));
}

function mount(sessions: Session[], panelBranch = branch) {
  agorStore.setState({ sessionsByBranch: new Map([[branch.branch_id, sessions]]) });
  const onSessionClick = vi.fn();
  const { container } = render(
    <App>
      <div data-testid="panel-container" style={{ height: 1100, width: 300 }}>
        <BoardTeammatePanel
          board={{ board_id: 'board-1' } as Board}
          primaryTeammateBranch={panelBranch}
          primaryTeammateRepo={{ repo_id: branch.repo_id, slug: 'test/repo' } as Repo}
          primaryTeammateInaccessible={false}
          onSessionClick={onSessionClick}
          client={null}
        />
      </div>
    </App>
  );
  return { container, onSessionClick };
}

it.each([false, true])(
  'fills and resizes the teammate container while virtualizing (gateway: %s)',
  async (gateway) => {
    const { container, onSessionClick } = mount(makeSessions(1001, gateway));
    const host = screen.getByTestId('panel-container');
    const scroller = () => container.querySelector<HTMLElement>('.ant-tree-list-holder')!;
    const expectFillsPanel = async () => {
      await waitFor(() => {
        const bottom = scroller().getBoundingClientRect().bottom;
        const gap = host.getBoundingClientRect().bottom - bottom;
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThan(40);
        expect(
          screen.getAllByRole('button', { name: /^Open session Conversation/ }).length
        ).toBeLessThan(80);
      });
    };
    await expectFillsPanel();
    expect(scroller().clientHeight).toBeGreaterThan(600);
    await act(async () => {
      host.style.height = '500px';
    });
    await expectFillsPanel();
    expect(scroller().clientHeight).toBeLessThan(400);
    await act(async () => {
      host.style.height = '950px';
    });
    await expectFillsPanel();
    const section = screen.getByText(gateway ? 'Gateway Sessions' : 'Sessions', {
      selector: 'strong',
    });
    fireEvent.click(section);
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());
    fireEvent.click(section);
    await expectFillsPanel();
    fireEvent.click(screen.getByRole('tab', { name: /Comments/ }));
    await act(async () => {
      host.style.height = '1000px';
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Teammate' }));
    await expectFillsPanel();
    for (let attempt = 0; attempt < 10; attempt++) {
      await act(async () => {
        scroller().scrollTop = scroller().scrollHeight;
        fireEvent.scroll(scroller());
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open session Conversation 1000' }));
    expect(onSessionClick).toHaveBeenCalledWith('session-1000');
  }
);

it('shares remaining space between trees and keeps scheduled runs and search reachable', async () => {
  const manual = makeSessions(301);
  const gateway = makeGatewaySessions(301);
  const scheduled = makeSessions(21).map((session, index) => ({
    ...session,
    session_id: `scheduled-${index}` as Session['session_id'],
    scheduled_from_branch: true,
    scheduled_run_at: 1000 - index,
    genealogy: { children: [] },
  }));
  const { container } = mount([...manual, ...gateway, ...scheduled]);
  const scrollers = () => [...container.querySelectorAll<HTMLElement>('.ant-tree-list-holder')];
  await waitFor(() => {
    expect(scrollers()).toHaveLength(2);
    expect(scrollers()[0].clientHeight).toBeGreaterThan(80);
    expect(scrollers()[1].clientHeight).toBeGreaterThan(80);
  });
  fireEvent.click(screen.getByRole('button', { name: /Scheduled Runs/ }));
  await waitFor(() => expect(scrollers()[0].clientHeight).toBeGreaterThan(300));
  const beforeParentCollapseHeight = scrollers()[1].clientHeight;
  const manualSection = scrollers()[0].closest('.ant-collapse') as HTMLElement;
  fireEvent.click(within(manualSection).getByRole('button', { name: 'Collapse Conversation 0' }));
  await waitFor(() => {
    expect(scrollers()[1].clientHeight).toBeGreaterThan(beforeParentCollapseHeight + 150);
    expect(
      manualSection.getBoundingClientRect().bottom - scrollers()[0].getBoundingClientRect().bottom
    ).toBeLessThan(20);
  });
  fireEvent.click(within(manualSection).getByRole('button', { name: 'Expand Conversation 0' }));
  await waitFor(() => expect(scrollers()[0].clientHeight).toBeGreaterThan(300));
  const sharedHeight = scrollers()[1].clientHeight;
  fireEvent.click(screen.getByText('Sessions', { selector: 'strong' }));
  await waitFor(() => {
    expect(scrollers()).toHaveLength(1);
    expect(scrollers()[0].clientHeight).toBeGreaterThan(sharedHeight + 200);
  });
  fireEvent.click(screen.getByRole('button', { name: /Scheduled Runs/ }));
  fireEvent.click(screen.getByTitle('Next Page'));
  expect(screen.getByTitle('Previous Page')).not.toBeNull();
  fireEvent.change(screen.getByPlaceholderText('Search sessions...'), {
    target: { value: 'Conversation' },
  });
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: /^Open session Conversation/ })).toHaveLength(20)
  );
  fireEvent.change(screen.getByPlaceholderText('Search sessions...'), { target: { value: '' } });
  await waitFor(() => expect(scrollers()).toHaveLength(1));
  expect(screen.getAllByRole('button', { name: /^Open session Conversation/ }).length).toBeLessThan(
    80
  );
});

it('keeps short and empty trees natural', async () => {
  const { container } = mount(makeSessions(2));
  expect(screen.getAllByRole('button', { name: /^Open session Conversation/ })).toHaveLength(2);
  expect(container.querySelector<HTMLElement>('.ant-tree-list-holder')!.clientHeight).toBeLessThan(
    200
  );
  await act(async () => {
    agorStore.setState({ sessionsByBranch: new Map() });
  });
  expect(screen.queryByRole('tree')).toBeNull();
});

it('keeps the tree reachable below a long description in a short container', async () => {
  const { container } = mount(makeSessions(), {
    ...branch,
    notes: Array.from({ length: 12 }, (_, index) => `Paragraph ${index}: teammate context.`).join(
      '\n\n'
    ),
  });
  const host = screen.getByTestId('panel-container');
  await act(async () => {
    host.style.height = '450px';
  });
  const tree = container.querySelector<HTMLElement>('.ant-tree-list-holder')!;
  await waitFor(() => {
    expect(tree.clientHeight).toBeGreaterThan(50);
    expect(tree.clientHeight).toBeLessThan(200);
  });
  tree.scrollIntoView({ block: 'end' });
  await waitFor(() => {
    expect(tree.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      host.getBoundingClientRect().bottom
    );
    expect(tree.getBoundingClientRect().top).toBeGreaterThan(host.getBoundingClientRect().top);
  });
  expect(screen.getAllByRole('button', { name: /^Open session Conversation/ }).length).toBeLessThan(
    40
  );
});

it.each([
  { manualCount: 1, gatewayCount: 301 },
  { manualCount: 1, gatewayCount: 1 },
  { manualCount: 2, gatewayCount: 301 },
  { manualCount: 301, gatewayCount: 2 },
  { manualCount: 2, gatewayCount: 2 },
])(
  'releases unused space with $manualCount manual and $gatewayCount gateway sessions',
  async ({ manualCount, gatewayCount }) => {
    const { container } = mount([
      ...makeSessions(manualCount),
      ...makeGatewaySessions(gatewayCount),
    ]);
    const scrollers = () => [...container.querySelectorAll<HTMLElement>('.ant-tree-list-holder')];
    // Initial allocation also waits for Collapse motion and ResizeObserver
    // redistribution. Use the same bounded convergence window as live growth
    // below; an intermediate equal split must not satisfy the geometry checks.
    await waitFor(
      () => {
        expect(scrollers()).toHaveLength(2);
        for (const [index, count] of [manualCount, gatewayCount].entries()) {
          const tree = scrollers()[index];
          if (count <= 2) {
            const section = tree.closest('.ant-collapse')!;
            // Only the Collapse body padding may follow the rendered short tree.
            expect(
              section.getBoundingClientRect().bottom - tree.getBoundingClientRect().bottom
            ).toBeLessThan(20);
          } else {
            expect(tree.clientHeight).toBeGreaterThan(500);
          }
        }
      },
      { timeout: 5_000 }
    );
    // Realtime growth must remove the short-tree cap; later shrink must restore it.
    await act(async () => {
      agorStore.setState({
        sessionsByBranch: new Map([
          [branch.branch_id, [...makeSessions(301), ...makeGatewaySessions(301)]],
        ]),
      });
    });
    // Real tree motion and ResizeObserver allocation can settle after the default
    // timeout under CI load; keep the geometry assertion and allow bounded convergence.
    await waitFor(
      () => {
        for (const tree of scrollers()) expect(tree.clientHeight).toBeGreaterThan(300);
      },
      { timeout: 5_000 }
    );
    await act(async () => {
      agorStore.setState({
        sessionsByBranch: new Map([
          [branch.branch_id, [...makeSessions(2), ...makeGatewaySessions(2)]],
        ]),
      });
    });
    await waitFor(() => {
      for (const tree of scrollers()) {
        expect(
          tree.closest('.ant-collapse')!.getBoundingClientRect().bottom -
            tree.getBoundingClientRect().bottom
        ).toBeLessThan(20);
      }
    });
  }
);
