import type { Board, Branch } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BoardTile, getBoardEmoji } from './BoardTile';

const teammateBranch = (emoji: string): Branch =>
  ({ custom_context: { teammate: { kind: 'teammate', emoji } } }) as unknown as Branch;

describe('getBoardEmoji', () => {
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
