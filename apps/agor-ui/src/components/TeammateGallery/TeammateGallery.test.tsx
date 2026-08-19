/**
 * Query style mirrors OnboardingWizard.test.tsx: antd `Tag` + jsdom `cssstyle`
 * crash on accessible-name computation, so this file uses text queries +
 * `closest('[role="radio"]')` instead of `getByRole`.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { getCategoryColor } from '../../utils/teammateTemplates';
import { TeammateGallery } from './TeammateGallery';

function cardFor(title: string): HTMLElement {
  const card = screen.getByText(title).closest('[role="radio"]');
  if (!card) throw new Error(`No card found for "${title}"`);
  return card as HTMLElement;
}

/** Card titles in DOM order (skips the blank starter unless present). */
function cardOrder(): string[] {
  const group = screen.getByRole('radiogroup', { name: 'Teammate template' });
  return Array.from(group.querySelectorAll('[role="radio"]')).map(
    (card) => card.getAttribute('aria-label') ?? ''
  );
}

/** The filter-chip row (role=group), used to scope chip queries away from badges. */
function chipRow(): HTMLElement {
  return screen.getByRole('group', { name: 'Filter templates by category' });
}

describe('TeammateGallery', () => {
  it('renders all eight templates plus the blank starter as a single-select radiogroup', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);

    expect(screen.getByRole('radiogroup', { name: 'Teammate template' })).toBeInTheDocument();
    for (const title of [
      'Competitive Analyst',
      'Product Manager',
      'Chief of Staff',
      'Financial Analyst',
      'Deal Desk Analyst',
      'Outbound Analyst',
      'Legal Analyst',
      'Builder',
      'Start blank',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('lays the cards out in a responsive multi-column grid', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'Teammate template' });
    expect(group).toHaveStyle({ display: 'grid' });
    // Two columns at the modal width, collapsing to one only when very narrow.
    expect(group).toHaveStyle({ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' });
  });

  it('renders each description in full with no ellipsis truncation', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    // The Competitive Analyst copy used to truncate ("...then tells you...") in
    // the narrow carousel; the full sentence must now be present verbatim.
    expect(
      screen.getByText(
        "Tracks every rival's pricing, launches, and moves, then tells you what it means for the next deal."
      )
    ).toBeInTheDocument();
  });

  it('reports the clicked template id (blank included) and reflects selection', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TeammateGallery value={null} onChange={onChange} />);

    fireEvent.click(cardFor('Legal Analyst'));
    expect(onChange).toHaveBeenLastCalledWith('legal-analyst');

    fireEvent.click(cardFor('Start blank'));
    expect(onChange).toHaveBeenLastCalledWith('blank');

    rerender(<TeammateGallery value="legal-analyst" onChange={onChange} />);
    expect(cardFor('Legal Analyst')).toHaveAttribute('aria-checked', 'true');
    expect(cardFor('Product Manager')).toHaveAttribute('aria-checked', 'false');
  });

  it('selects via keyboard (Enter / Space)', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value={null} onChange={onChange} />);

    fireEvent.keyDown(cardFor('Product Manager'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('product-manager');

    fireEvent.keyDown(cardFor('Competitive Analyst'), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('competitive-analyst');
  });

  it('badges up to two goal-recommended templates and never the blank card', () => {
    render(<TeammateGallery goals={['dig-into-anything']} value={null} onChange={vi.fn()} />);

    // dig-into-anything → competitive + financial analyst. Scope to the grid so
    // the "Recommended" filter chip isn't counted as a badge.
    const grid = screen.getByRole('radiogroup', { name: 'Teammate template' });
    expect(within(grid).getAllByText('Recommended')).toHaveLength(2);
    expect(cardFor('Competitive Analyst')).toHaveTextContent('Recommended');
    expect(cardFor('Financial Analyst')).toHaveTextContent('Recommended');
    expect(cardFor('Product Manager')).not.toHaveTextContent('Recommended');
    expect(cardFor('Start blank')).not.toHaveTextContent('Recommended');
  });

  it('shows no badge when the selected goals map to no template', () => {
    // Every real goal now maps to a template; only unknown goal ids resolve to nothing.
    render(<TeammateGallery goals={['not-a-goal']} value={null} onChange={vi.fn()} />);
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('shows no badge when no goals are supplied', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('renders category filter chips; the Recommended chip only when goals produce recs', () => {
    const { rerender } = render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const chips = chipRow();
    for (const label of ['All', 'Grow', 'Build', 'Operate']) {
      expect(within(chips).getByText(label)).toBeInTheDocument();
    }
    // No goals → no Recommended chip.
    expect(within(chips).queryByText('Recommended')).not.toBeInTheDocument();

    rerender(<TeammateGallery goals={['dig-into-anything']} value={null} onChange={vi.fn()} />);
    expect(within(chipRow()).getByText('Recommended')).toBeInTheDocument();
  });

  it('filters the grid to a category and hides the blank starter', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    fireEvent.click(within(chipRow()).getByText('Grow'));

    // Grow templates only; other categories + blank are gone.
    expect(cardOrder()).toEqual(['Competitive Analyst', 'Deal Desk Analyst', 'Outbound Analyst']);
    expect(screen.queryByText('Product Manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Start blank')).not.toBeInTheDocument();
  });

  it('sorts recommended cards to the front in the All view, blank last', () => {
    render(<TeammateGallery goals={['dig-into-anything']} value={null} onChange={vi.fn()} />);
    const order = cardOrder();
    expect(order.slice(0, 2)).toEqual(['Competitive Analyst', 'Financial Analyst']);
    expect(order.at(-1)).toBe('Start blank');
  });

  it('color-codes each card icon with its category palette color', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    // jsdom serializes the inline color as rgb(...), so compare against rgb.
    const rgbOf = (hex: string): string => {
      const n = Number.parseInt(hex.replace('#', ''), 16);
      // biome-ignore lint/plugin/noHardcodedColorLiteral: builds an rgb() string from a palette hex to assert against jsdom's serialized color — not a UI color literal
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const growRgb = rgbOf(getCategoryColor('grow') ?? '');
    const operateRgb = rgbOf(getCategoryColor('operate') ?? '');

    // Read the raw inline style: toHaveStyle would trip the cssstyle crash on the
    // antd Card's CSS-var border shorthand (see file header).
    const growIcon = cardFor('Competitive Analyst').querySelector('.anticon');
    const operateIcon = cardFor('Legal Analyst').querySelector('.anticon');
    expect(growIcon?.getAttribute('style')).toContain(growRgb);
    expect(operateIcon?.getAttribute('style')).toContain(operateRgb);
    // Different categories render different icon colors.
    expect(growRgb).not.toBe(operateRgb);
  });
});
