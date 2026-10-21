import type { Session } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { OpenSessionsSwitcher } from './OpenSessions';
import { SessionTabs, splitVisibleTabs } from './SessionTabs';
import { formatNeedsYou, getSessionTabStatus } from './sessionTabStatus';

vi.mock('../ToolIcon', () => ({ ToolIcon: () => null }));

const session = (id: string, extra: Partial<Session> = {}) =>
  ({
    session_id: id,
    title: `Session ${id}`,
    agentic_tool: 'claude-code',
    status: 'idle',
    ready_for_prompt: false,
    ...extra,
  }) as Session;

/** The tab components read their live sessions from the store. */
const seed = (...sessions: Session[]) => {
  agorStore.setState({ sessionById: new Map(sessions.map((s) => [s.session_id, s])) });
  return sessions.map((s) => s.session_id);
};

afterEach(() => {
  cleanup();
  agorStore.setState({ ...EMPTY_MAPS });
});

describe('getSessionTabStatus', () => {
  it.each([
    ['awaiting_permission', 'needs-you'],
    ['awaiting_input', 'needs-you'],
    ['timed_out', 'needs-you'],
    ['running', 'running'],
    ['stopping', 'running'],
    ['failed', 'failed'],
    ['idle', 'idle'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(getSessionTabStatus(session('a', { status }))).toBe(expected);
  });

  it('shows an unread result only on tabs that are not selected', () => {
    const done = session('a', { ready_for_prompt: true });
    expect(getSessionTabStatus(done)).toBe('unread');
    expect(getSessionTabStatus(done, true)).toBe('idle');
  });
});

describe('formatNeedsYou', () => {
  it('uses singular and plural copy', () => {
    expect(formatNeedsYou([session('a')])).toBe('1 needs you: Session a');
    expect(formatNeedsYou([session('a'), session('b')])).toBe('2 need you: Session a, Session b');
  });
});

describe('splitVisibleTabs', () => {
  const sessions = ['a', 'b', 'c', 'd', 'e'].map((id) => session(id));
  const ids = (list: Session[]) => list.map((s) => s.session_id);

  it('shows every tab when they fit, stretched up to the maximum width', () => {
    const two = sessions.slice(0, 2);
    expect(splitVisibleTabs(two, 'a', 460)).toMatchObject({ hidden: [], tabWidth: 228 });
    const wide = splitVisibleTabs(two, 'a', 660);
    expect(ids(wide.visible)).toEqual(['a', 'b']);
    expect(wide.tabWidth).toBe(280);
  });

  it('moves the rest into More in order and keeps the selected tab visible', () => {
    const { visible, hidden, tabWidth } = splitVisibleTabs(sessions, 'e', 600);
    expect(ids(visible)).toEqual(['a', 'e']);
    expect(ids(hidden)).toEqual(['b', 'c', 'd']);
    // The fitting tabs share the row up to More instead of leaving a gap.
    expect(tabWidth).toBe(250);
  });

  it('keeps one tab at the minimum width before the bar is measured', () => {
    expect(splitVisibleTabs(sessions, 'c', 0)).toMatchObject({
      visible: [sessions[2]],
      tabWidth: 200,
    });
  });
});

describe('SessionTabs', () => {
  it('counts hidden tabs that need you on a neutral More button and closes tabs', () => {
    const onClose = vi.fn();
    const onHide = vi.fn();
    const ids = seed(session('a'), session('b', { status: 'awaiting_permission' }), session('c'));
    render(
      <SessionTabs
        ids={ids}
        selectedId="a"
        onSelect={vi.fn()}
        onClose={onClose}
        onCloseOthers={vi.fn()}
        onHide={onHide}
      />
    );

    const more = screen.getByRole('button', { name: /2 more/ });
    expect(within(more.parentElement as HTMLElement).getByText('1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }));
    expect(onClose).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'Hide panel' }));
    expect(onHide).toHaveBeenCalled();
  });

  it('leaves out Hide panel when there is nowhere to hide to', () => {
    render(
      <SessionTabs
        ids={seed(session('a'), session('b'))}
        selectedId="a"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
      />
    );
    expect(screen.queryByRole('button', { name: 'Hide panel' })).not.toBeInTheDocument();
  });
});

describe('OpenSessionsSwitcher', () => {
  it('lists every open session with its status and closes one', async () => {
    const onClose = vi.fn();
    render(
      <OpenSessionsSwitcher
        ids={seed(session('a'), session('b', { status: 'failed' }))}
        selectedId="a"
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open sessions, 2 open' }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Open sessions')).toBeInTheDocument();
    expect(within(sheet).getByText('Failed')).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close tab: Session b' }));
    expect(onClose).toHaveBeenCalledWith('b');
  });
});
