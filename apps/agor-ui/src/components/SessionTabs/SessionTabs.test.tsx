import type { Session } from '@agor-live/client';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(cleanup);

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

  it('shows every tab when they fit', () => {
    expect(ids(splitVisibleTabs(sessions.slice(0, 2), 'a', 700).visible)).toEqual(['a', 'b']);
  });

  it('moves the rest into More in order and keeps the selected tab visible', () => {
    const { visible, hidden } = splitVisibleTabs(sessions, 'e', 700);
    expect(ids(visible)).toEqual(['a', 'e']);
    expect(ids(hidden)).toEqual(['b', 'c', 'd']);
  });
});

describe('SessionTabs', () => {
  it('counts hidden tabs that need you on a neutral More button and closes tabs', () => {
    const onClose = vi.fn();
    const onHide = vi.fn();
    render(
      <SessionTabs
        sessions={[session('a'), session('b', { status: 'awaiting_permission' }), session('c')]}
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
});

describe('OpenSessionsSwitcher', () => {
  it('lists every open session with its status and closes one', async () => {
    const onClose = vi.fn();
    render(
      <OpenSessionsSwitcher
        sessions={[session('a'), session('b', { status: 'failed' })]}
        selectedId="a"
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /2 open/ }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Open sessions')).toBeInTheDocument();
    expect(within(sheet).getByText('Failed')).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close tab: Session b' }));
    expect(onClose).toHaveBeenCalledWith('b');
  });
});
