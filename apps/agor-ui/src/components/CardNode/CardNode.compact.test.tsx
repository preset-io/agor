import { GENERIC_BOARD_CARD_LAYOUT } from '@agor/core/layout/zone-layout';
import type { CardWithType } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CardNode from './CardNode';

function makeCard(overrides: Partial<CardWithType> = {}): CardWithType {
  return {
    card_id: 'card-1',
    title: 'Planning card',
    description: 'Persist this exact description.',
    note: 'Persist this exact note.',
    archived: false,
    ...overrides,
  } as unknown as CardWithType;
}

describe('CardNode density capability', () => {
  it('exposes an accessible collapse action and requests persisted compact state', () => {
    const onToggleCompact = vi.fn();
    render(<CardNode data={{ card: makeCard(), onToggleCompact }} />);

    fireEvent.click(screen.getByLabelText('Collapse card'));

    expect(onToggleCompact).toHaveBeenCalledWith('card-1', true);
    expect(screen.getByText('Persist this exact description.')).toBeTruthy();
    expect(screen.getByText('Persist this exact note.')).toBeTruthy();
  });

  it('genuinely hides the whole lower body and restores the exact content', () => {
    const onToggleCompact = vi.fn();
    const { rerender } = render(
      <CardNode data={{ card: makeCard(), compact: true, onToggleCompact }} />
    );

    expect(screen.getByText('Planning card')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Planning card details' })).toBeNull();
    expect(screen.queryByText('Persist this exact description.')).toBeNull();
    expect(screen.queryByText('Persist this exact note.')).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand card'));
    expect(onToggleCompact).toHaveBeenCalledWith('card-1', false);

    rerender(<CardNode data={{ card: makeCard(), compact: false, onToggleCompact }} />);
    expect(screen.getByRole('region', { name: 'Planning card details' })).toBeTruthy();
    expect(screen.getByText('Persist this exact description.')).toBeTruthy();
    expect(screen.getByText('Persist this exact note.')).toBeTruthy();
  });

  it('keeps very long description and note content in one bounded keyboard scroll region', () => {
    const description = 'Fictional launch description. '.repeat(200);
    const note = 'Fictional status line.\n'.repeat(200);
    render(<CardNode data={{ card: makeCard({ description, note }), onToggleCompact: vi.fn() }} />);

    const body = screen.getByRole('region', { name: 'Planning card details' });
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(body.classList).toEqual(expect.objectContaining(['nodrag', 'nopan', 'nowheel']));
    expect(body.style.maxHeight).toBe(`${GENERIC_BOARD_CARD_LAYOUT.bodyMaxHeight}px`);
    expect(body.style.overflowY).toBe('auto');
    expect(body.style.overscrollBehavior).toBe('contain');
    expect(body.textContent).toContain(note);
    expect(screen.getByLabelText('Collapse card').closest('[data-card-density-body]')).toBeNull();

    // MarkdownPreview measures rendered overflow in a real browser; happy-dom
    // keeps the complete source in the DOM without manufacturing that control.
    expect(body.textContent).toContain(description.trim());
    fireEvent.focus(body);
    expect(body.style.boxShadow).toContain('inset 0 0 0 2px');
    fireEvent.blur(body);
    expect(body.style.boxShadow).toBe('none');
  });

  it('does not manufacture a toggle or hide content on a header-only card', () => {
    render(
      <CardNode
        data={{
          card: makeCard({ description: undefined, note: undefined }),
          compact: true,
          onToggleCompact: vi.fn(),
        }}
      />
    );

    expect(screen.getByText('Planning card')).toBeTruthy();
    expect(screen.queryByLabelText('Collapse card')).toBeNull();
    expect(screen.queryByLabelText('Expand card')).toBeNull();
  });

  it('omits the mutation action for a viewer while preserving body content', () => {
    render(<CardNode data={{ card: makeCard(), compact: true }} />);

    expect(screen.queryByLabelText('Expand card')).toBeNull();
    expect(screen.queryByText('Persist this exact description.')).toBeNull();
  });

  it('keeps density before pin and drag and preserves the stack interaction callback', () => {
    const onToggleCompact = vi.fn();
    const onAutoZoneInteraction = vi.fn();
    const { container } = render(
      <CardNode
        data={{
          card: makeCard({ url: 'https://example.test/card' }),
          isPinned: true,
          compact: true,
          onToggleCompact,
          onUnpin: vi.fn(),
          onAutoZoneInteraction,
        }}
      />
    );

    const header = container.querySelector('[data-zone-stack-header]');
    const buttons = header?.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons?.[0]).toBe(screen.getByLabelText('Expand card'));
    fireEvent.pointerDown(screen.getByLabelText('Expand card'));
    fireEvent.click(screen.getByLabelText('Expand card'));
    expect(onAutoZoneInteraction).toHaveBeenCalledWith('card-1');
    expect(onToggleCompact).toHaveBeenCalledWith('card-1', false);
  });
});
