/**
 * Real-browser guard for the honest board-density capability boundary.
 *
 * Run: pnpm vitest run --config vitest.browser.config.ts
 */

import { GENERIC_BOARD_CARD_LAYOUT } from '@agor/core/layout/zone-layout';
import type { CardWithType } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CardNode from './CardNode';

afterEach(cleanup);

function makeCard(): CardWithType {
  return {
    card_id: 'card-1',
    title: 'Refine onboarding copy',
    description:
      'The welcome step still reads like internal jargon. Rewrite it around a new teammate.',
    note: 'Blocked on the copy review going out Thursday.',
    effective_emoji: '📝',
    archived: false,
  } as unknown as CardWithType;
}

describe('CardNode density capability (real browser)', () => {
  it('measures a smaller real DOM rectangle after hiding the lower body', () => {
    const { rerender } = render(
      <CardNode data={{ card: makeCard(), onToggleCompact: () => undefined }} />
    );

    expect(screen.getByText(/welcome step still reads/)).toBeTruthy();
    expect(screen.getByText(/Blocked on the copy review/)).toBeTruthy();
    const title = screen.getByText('Refine onboarding copy');
    const expandedHeight = title.closest('[style*="width: 380px"]')?.getBoundingClientRect().height;
    fireEvent.click(screen.getByLabelText('Collapse card'));
    rerender(
      <CardNode data={{ card: makeCard(), compact: true, onToggleCompact: () => undefined }} />
    );

    const compactHeight = title.closest('[style*="width: 380px"]')?.getBoundingClientRect().height;
    expect(screen.queryByText(/welcome step still reads/)).toBeNull();
    expect(screen.queryByText(/Blocked on the copy review/)).toBeNull();
    expect(compactHeight).toBeLessThan(expandedHeight ?? 0);
    expect(title.getBoundingClientRect().width).toBeGreaterThan(100);
  });

  it('bounds a very long expanded body and makes the complete content internally scrollable', () => {
    const description = 'Fictional expanded detail. '.repeat(400);
    const note = 'Fictional status row.\n'.repeat(400);
    const card = makeCard() as CardWithType;
    card.description = description;
    card.note = note;
    const { rerender } = render(<CardNode data={{ card, onToggleCompact: () => undefined }} />);

    const body = screen.getByRole('region', { name: 'Refine onboarding copy details' });
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    const expandedCard = screen
      .getByText('Refine onboarding copy')
      .closest('[style*="width: 380px"]');

    expect(body.clientHeight).toBe(GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight * 10);
    expect(getComputedStyle(body).overflowY).toBe('auto');
    expect(expandedCard?.getBoundingClientRect().height).toBeLessThan(
      GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight + 80
    );
    act(() => body.focus());
    expect(document.activeElement).toBe(body);

    act(() =>
      rerender(<CardNode data={{ card, compact: true, onToggleCompact: () => undefined }} />)
    );
    expect(screen.queryByRole('region', { name: 'Refine onboarding copy details' })).toBeNull();
    expect(screen.queryByText(description)).toBeNull();
    expect(screen.queryByText(note)).toBeNull();
  });
});
