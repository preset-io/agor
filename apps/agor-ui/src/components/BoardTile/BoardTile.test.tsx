import type { Board, Branch } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BoardTile, boardSelectFilter, boardSelectOptions, getBoardEmoji } from './BoardTile';

const teammateBranch = (emoji: string): Branch =>
  ({ custom_context: { teammate: { kind: 'teammate', emoji } } }) as unknown as Branch;

const board = (id: string, name: string, primary_teammate_id?: string): Board =>
  ({ board_id: id, name, primary_teammate_id }) as unknown as Board;

describe('getBoardEmoji', () => {
  it('prefers the board-owned icon over its primary teammate emoji', () => {
    const branchById = new Map<string, Branch>([['b1', teammateBranch('🦊')]]);
    expect(getBoardEmoji({ icon: '🧭', primary_teammate_id: 'b1' } as Board, branchById)).toBe(
      '🧭'
    );
  });

  it('resolves the primary teammate branch emoji', () => {
    const branchById = new Map<string, Branch>([['b1', teammateBranch('🦊')]]);
    expect(getBoardEmoji({ primary_teammate_id: 'b1' } as Board, branchById)).toBe('🦊');
  });

  it('returns undefined when the board has no primary teammate', () => {
    expect(getBoardEmoji({} as Board, new Map())).toBeUndefined();
  });

  it('returns undefined when the teammate branch is not loaded', () => {
    expect(getBoardEmoji({ primary_teammate_id: 'missing' } as Board, new Map())).toBeUndefined();
  });
});

describe('BoardTile', () => {
  it('renders the assistant emoji when one is provided', () => {
    render(<BoardTile emoji="🦊" />);
    expect(screen.getByText('🦊')).toBeInTheDocument();
  });

  it('falls back to a neutral glyph when there is no emoji', () => {
    const { container } = render(<BoardTile />);
    expect(container.querySelector('.anticon')).toBeInTheDocument();
  });
});

describe('boardSelectOptions', () => {
  const branchById = new Map<string, Branch>([['b1', teammateBranch('🦊')]]);

  it('sorts by name and carries a plain-name field for filtering', () => {
    const opts = boardSelectOptions([board('2', 'Zebra'), board('1', 'Alpha')], branchById);
    expect(opts.map((o) => o.name)).toEqual(['Alpha', 'Zebra']);
    expect(opts.map((o) => o.value)).toEqual(['1', '2']);
  });

  it('renders the assistant emoji for a board that has one', () => {
    const [opt] = boardSelectOptions([board('1', 'Alpha', 'b1')], branchById);
    render(<>{opt.label}</>);
    expect(screen.getByText('🦊')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });

  it('renders the board-owned icon when it differs from the primary teammate', () => {
    const [opt] = boardSelectOptions(
      [{ ...board('1', 'Alpha', 'b1'), icon: '🧭' } as Board],
      branchById
    );
    render(<>{opt.label}</>);
    expect(screen.getByText('🧭')).toBeInTheDocument();
    expect(screen.queryByText('🦊')).not.toBeInTheDocument();
  });

  it('renders the neutral tile (never a bare name) for an assistant-less board', () => {
    const [opt] = boardSelectOptions([board('1', 'Alpha')], branchById);
    const { container } = render(<>{opt.label}</>);
    expect(container.querySelector('.anticon')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
});

describe('boardSelectFilter', () => {
  const opt = { value: '1', label: null, name: 'Design Board' };

  it('matches on the board name, case-insensitively', () => {
    expect(boardSelectFilter('design', opt)).toBe(true);
    expect(boardSelectFilter('BOARD', opt)).toBe(true);
    expect(boardSelectFilter('xyz', opt)).toBe(false);
  });
});
