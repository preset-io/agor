/**
 * Query style mirrors OnboardingWizard.test.tsx: antd `Tag` + jsdom `cssstyle`
 * crash on accessible-name computation, so this file uses text queries +
 * `closest('[role="button"]')` instead of `getByRole`.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { AggregationColor } from 'antd/es/color-picker/color';
import {
  getCategoryColor,
  TEAMMATE_TEMPLATES,
  TEMPLATE_CATEGORIES,
} from '../../utils/teammateTemplates';
import { TeammateGallery, TeammateGalleryCards } from './TeammateGallery';

function cardFor(title: string): HTMLElement {
  const card = screen.getByText(title).closest('[role="button"]');
  if (!card) throw new Error(`No card found for "${title}"`);
  return card as HTMLElement;
}

/** Card titles in DOM order (skips the blank starter unless present). */
function cardOrder(): string[] {
  const group = screen.getByRole('group', { name: 'Teammate template' });
  return Array.from(group.querySelectorAll('[role="button"]')).map(
    (card) => card.getAttribute('aria-label') ?? ''
  );
}

/** The exclusive category control, used to scope queries away from badges. */
function chipRow(): HTMLElement {
  return screen.getByRole('radiogroup', { name: 'Filter templates by category' });
}

/** jsdom serializes inline colors as rgb(...); convert a palette hex to match. */
function rgbOf(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  // biome-ignore lint/plugin/noHardcodedColorLiteral: builds an rgb() string from a palette hex to assert against jsdom's serialized color — not a UI color literal
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const { r, g, b } = new AggregationColor(color).toRgb();
    const linearize = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('TeammateGallery', () => {
  it('renders all eight templates plus the blank starter as an optional single-select button group', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'Teammate template' })).toBeInTheDocument();
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
    const group = screen.getByRole('group', { name: 'Teammate template' });
    expect(group).toHaveStyle({ display: 'grid' });
    // Three columns at the widened modal, stepping down to two/one as it narrows.
    expect(group).toHaveStyle({ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' });
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
    expect(cardFor('Legal Analyst')).toHaveAttribute('aria-pressed', 'true');
    expect(cardFor('Product Manager')).toHaveAttribute('aria-pressed', 'false');
  });

  it('selects via keyboard (Enter / Space)', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value={null} onChange={onChange} />);

    fireEvent.keyDown(cardFor('Product Manager'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('product-manager');

    fireEvent.keyDown(cardFor('Competitive Analyst'), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('competitive-analyst');
  });

  it('single-click toggles: unselected card selects, the selected card deselects', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value="legal-analyst" onChange={onChange} />);

    // Click an unselected card → selects it.
    fireEvent.click(cardFor('Product Manager'));
    expect(onChange).toHaveBeenLastCalledWith('product-manager');

    // Click the already-selected card → clears the pick (single click, no dblclick).
    fireEvent.click(cardFor('Legal Analyst'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('keyboard (Enter/Space) toggles both ways', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value="legal-analyst" onChange={onChange} />);

    // Enter on the already-selected card clears it.
    fireEvent.keyDown(cardFor('Legal Analyst'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(null);

    // Space on a different (unselected) card selects it.
    onChange.mockClear();
    fireEvent.keyDown(cardFor('Product Manager'), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('product-manager');
  });

  it('single-click / keyboard also toggles the blank starter off when selected', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value="blank" onChange={onChange} />);

    fireEvent.click(cardFor('Start blank'));
    expect(onChange).toHaveBeenLastCalledWith(null);

    onChange.mockClear();
    fireEvent.keyDown(cardFor('Start blank'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('compact variant leads with the recommended Team assistant, then emoji + title templates', () => {
    render(<TeammateGalleryCards value="blank" onChange={vi.fn()} compact />);

    const assistant = cardFor('Team assistant');
    expect(assistant).toHaveAttribute('aria-pressed', 'true');
    expect(assistant).toHaveTextContent('Recommended');
    expect(assistant).toHaveTextContent('Works with you and your team. A good place to start.');
    expect(screen.queryByText('Start blank')).not.toBeInTheDocument();
    expect(screen.getByText('Or start from a template')).toBeInTheDocument();

    // Template cards are compact: no category pill, description only in a tooltip.
    const template = cardFor('Legal Analyst');
    expect(template).toHaveTextContent('⚖️');
    expect(within(template).queryByText('Operate')).not.toBeInTheDocument();
    expect(template).not.toHaveTextContent('Reads the redline');
    expect(cardOrder()[0]).toBe('Team assistant');
  });

  it('renders exactly the All/Grow/Build/Operate chips and no Recommended badge', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const chips = chipRow();
    for (const label of ['All', 'Grow', 'Build', 'Operate']) {
      expect(within(chips).getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('models category filtering as one exclusive radio control with arrow-key navigation', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const radios = within(chipRow()).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(radios[0]).toBeChecked();

    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(within(chipRow()).getByRole('radio', { name: 'Grow' })).toBeChecked();
    expect(cardOrder()).toEqual(['Competitive Analyst', 'Deal Desk Analyst', 'Outbound Analyst']);
  });

  it('filters the grid to a category and hides the blank starter', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    fireEvent.click(within(chipRow()).getByText('Grow'));

    // Grow templates only; other categories + blank are gone.
    expect(cardOrder()).toEqual(['Competitive Analyst', 'Deal Desk Analyst', 'Outbound Analyst']);
    expect(screen.queryByText('Product Manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Start blank')).not.toBeInTheDocument();
  });

  it('shows a category pill per card in the category color (no icon tile); blank has none', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const growRgb = rgbOf(getCategoryColor('grow') ?? '');
    const operateRgb = rgbOf(getCategoryColor('operate') ?? '');

    // The colored category pill is now the sole carrier of the category hue — the
    // per-card icon tile was removed, so template cards render no icon.
    const growCard = cardFor('Competitive Analyst');
    expect(growCard.querySelector('.anticon')).toBeNull();

    // Grow card carries a "Grow" pill tinted the grow accent; a different category
    // (Operate) renders its own distinct hue.
    const growPill = within(growCard).getByText('Grow');
    expect(growPill.getAttribute('style')).toContain(growRgb);
    const operatePill = within(cardFor('Legal Analyst')).getByText('Operate');
    expect(operatePill.getAttribute('style')).toContain(operateRgb);
    expect(growRgb).not.toBe(operateRgb);

    // The blank starter has no category → no category pill.
    const blank = cardFor('Start blank');
    for (const label of ['Grow', 'Build', 'Operate']) {
      expect(within(blank).queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('uses a quiet category-colored selected state, not a bold blue 2px border', () => {
    render(<TeammateGallery value="competitive-analyst" onChange={vi.fn()} />);
    const growRgb = rgbOf(getCategoryColor('grow') ?? '');

    const selectedStyle = cardFor('Competitive Analyst').getAttribute('style') ?? '';
    // Category accent, thin border, faint wash — not the old loud 2px blue.
    expect(selectedStyle).toContain(growRgb);
    expect(selectedStyle).toContain('border-width: 1px');
    expect(selectedStyle).not.toContain('border-width: 2px');
  });

  it.each(TEMPLATE_CATEGORIES)(
    'keeps selected $label category text above normal-text contrast',
    (category) => {
      const template = TEAMMATE_TEMPLATES.find((candidate) => candidate.category === category.id);
      if (!template) throw new Error(`Missing template for ${category.id}`);
      render(<TeammateGallery value={template.id} onChange={vi.fn()} />);

      const pill = within(cardFor(template.title)).getByText(category.label);
      expect(contrastRatio(pill.style.color, category.color)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it('renders Start blank as a full-width dashed header card, first in the All view', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const blankStyle = cardFor('Start blank').getAttribute('style') ?? '';
    // Spans every column of the auto-fit grid → full-width header.
    expect(blankStyle).toContain('grid-column: 1 / -1');
    // Understated "build your own" affordance: dashed border.
    expect(blankStyle).toContain('border-style: dashed');
    // Leads the grid; the eight templates keep their normal (non-spanning) cells.
    expect(cardOrder()[0]).toBe('Start blank');
    expect(cardFor('Competitive Analyst').getAttribute('style') ?? '').not.toContain('grid-column');
  });

  it('keeps Start blank a dashed 1px card when selected (no layout shift)', () => {
    render(<TeammateGallery value="blank" onChange={vi.fn()} />);
    const blankStyle = cardFor('Start blank').getAttribute('style') ?? '';
    expect(blankStyle).toContain('border-style: dashed');
    expect(blankStyle).toContain('border-width: 1px');
    expect(blankStyle).not.toContain('border-width: 2px');
  });

  it('shows the ghost Clear filters button only when filtered, and it resets to All', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    // All is the default → no Clear filters button.
    expect(screen.queryByText('Clear filters')).toBeNull();

    fireEvent.click(within(chipRow()).getByText('Operate'));
    const clear = screen.getByText('Clear filters').closest('button');
    expect(clear).toBeInTheDocument();
    // Filtered: blank hidden.
    expect(screen.queryByText('Start blank')).not.toBeInTheDocument();

    fireEvent.click(clear as HTMLButtonElement);
    // Reset to All: every card back (blank first) and the button is gone.
    expect(screen.getByText('Start blank')).toBeInTheDocument();
    expect(screen.queryByText('Clear filters')).toBeNull();
  });
});
