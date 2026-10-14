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
  it('renders every template plus the blank starter as an optional single-select button group', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);

    expect(screen.getByRole('group', { name: 'Teammate template' })).toBeInTheDocument();
    for (const title of [
      'Personal assistant',
      'Researcher',
      'Engineering assistant',
      'Competitive analyst',
      'Product manager',
      'Chief of staff',
      'Financial analyst',
      'Deal desk analyst',
      'Outbound analyst',
      'Legal analyst',
      'Builder',
      'Start from scratch',
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

  it('renders each description in full in the full gallery', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    expect(
      screen.getByText("Tracks rivals' pricing, launches and moves for you.")
    ).toBeInTheDocument();
  });

  it('reports the clicked template id (blank included) and reflects selection', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TeammateGallery value={null} onChange={onChange} />);

    fireEvent.click(cardFor('Legal analyst'));
    expect(onChange).toHaveBeenLastCalledWith('legal-analyst');

    fireEvent.click(cardFor('Start from scratch'));
    expect(onChange).toHaveBeenLastCalledWith('blank');

    rerender(<TeammateGallery value="legal-analyst" onChange={onChange} />);
    expect(cardFor('Legal analyst')).toHaveAttribute('aria-pressed', 'true');
    expect(cardFor('Product manager')).toHaveAttribute('aria-pressed', 'false');
  });

  it('selects via keyboard (Enter / Space)', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value={null} onChange={onChange} />);

    fireEvent.keyDown(cardFor('Product manager'), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('product-manager');

    fireEvent.keyDown(cardFor('Competitive analyst'), { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('competitive-analyst');
  });

  it('is select-only: the selected card ignores clicks and Enter/Space', () => {
    const onChange = vi.fn();
    render(<TeammateGallery value="legal-analyst" onChange={onChange} />);

    fireEvent.click(cardFor('Product manager'));
    expect(onChange).toHaveBeenLastCalledWith('product-manager');

    // Re-selecting the current pick changes nothing; there is no deselect.
    onChange.mockClear();
    fireEvent.click(cardFor('Legal analyst'));
    fireEvent.keyDown(cardFor('Legal analyst'), { key: 'Enter' });
    fireEvent.keyDown(cardFor('Legal analyst'), { key: ' ' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('compact variant is one even grid: icon, title, one description line, blank first', () => {
    render(<TeammateGalleryCards value="personal-assistant" onChange={vi.fn()} compact />);

    expect(screen.getByRole('group', { name: 'Teammate template' })).toHaveStyle({
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    });
    const order = cardOrder();
    expect(order[0]).toBe('Start from scratch');
    expect(order[1]).toBe('Personal assistant');
    expect(order).toHaveLength(12);

    const assistant = cardFor('Personal assistant');
    expect(assistant).toHaveAttribute('aria-pressed', 'true');
    expect(assistant).toHaveTextContent("Keeps up with Slack and your docs so you don't have to.");
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
    expect(screen.queryByText('Or start from a template')).not.toBeInTheDocument();

    // No category pill, but the description line is on the card; blank is an ordinary card.
    // Each card shows its antd icon, never the avatar emoji.
    const template = cardFor('Legal analyst');
    expect(template.querySelector('.anticon-safety')).toBeInTheDocument();
    expect(template).not.toHaveTextContent('⚖️');
    expect(cardFor('Personal assistant').querySelector('.anticon-user')).toBeInTheDocument();
    expect(cardFor('Researcher').querySelector('.anticon-search')).toBeInTheDocument();
    expect(cardFor('Engineering assistant').querySelector('.anticon-code')).toBeInTheDocument();
    expect(template).toHaveTextContent('Reads the redline and flags the risk.');
    expect(within(template).queryByText('Operate')).not.toBeInTheDocument();
    const blank = cardFor('Start from scratch');
    expect(blank.querySelector('.anticon-plus')).toBeInTheDocument();
    expect(blank).not.toHaveTextContent('✨');
    expect(blank.getAttribute('style') ?? '').not.toContain('grid-column');
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
    expect(cardOrder()).toEqual([
      'Researcher',
      'Competitive analyst',
      'Deal desk analyst',
      'Outbound analyst',
    ]);
  });

  it('filters the grid to a category and hides the blank starter', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    fireEvent.click(within(chipRow()).getByText('Grow'));

    // Grow templates only; other categories + blank are gone.
    expect(cardOrder()).toEqual([
      'Researcher',
      'Competitive analyst',
      'Deal desk analyst',
      'Outbound analyst',
    ]);
    expect(screen.queryByText('Product manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Start from scratch')).not.toBeInTheDocument();
  });

  it('shows a category pill per card in the category color (no icon tile); blank has none', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const growRgb = rgbOf(getCategoryColor('grow') ?? '');
    const operateRgb = rgbOf(getCategoryColor('operate') ?? '');

    // The colored category pill is now the sole carrier of the category hue — the
    // per-card icon tile was removed, so template cards render no icon.
    const growCard = cardFor('Competitive analyst');
    expect(growCard.querySelector('.anticon')).toBeNull();

    // Grow card carries a "Grow" pill tinted the grow accent; a different category
    // (Operate) renders its own distinct hue.
    const growPill = within(growCard).getByText('Grow');
    expect(growPill.getAttribute('style')).toContain(growRgb);
    const operatePill = within(cardFor('Legal analyst')).getByText('Operate');
    expect(operatePill.getAttribute('style')).toContain(operateRgb);
    expect(growRgb).not.toBe(operateRgb);

    // The blank starter has no category → no category pill.
    const blank = cardFor('Start from scratch');
    for (const label of ['Grow', 'Build', 'Operate']) {
      expect(within(blank).queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('uses a quiet category-colored selected state, not a bold blue 2px border', () => {
    render(<TeammateGallery value="competitive-analyst" onChange={vi.fn()} />);
    const growRgb = rgbOf(getCategoryColor('grow') ?? '');

    const selectedStyle = cardFor('Competitive analyst').getAttribute('style') ?? '';
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

  it('renders Start from scratch as a full-width dashed card, first in the All view', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    const blankStyle = cardFor('Start from scratch').getAttribute('style') ?? '';
    // Spans every column of the auto-fit grid → full-width row.
    expect(blankStyle).toContain('grid-column: 1 / -1');
    // Understated "build your own" affordance: dashed border.
    expect(blankStyle).toContain('border-style: dashed');
    // Opens the grid; the templates keep their normal (non-spanning) cells.
    expect(cardOrder()[0]).toBe('Start from scratch');
    expect(cardOrder()[1]).toBe('Personal assistant');
    expect(cardFor('Competitive analyst').getAttribute('style') ?? '').not.toContain('grid-column');
  });

  it('keeps Start from scratch a dashed 1px card when selected (no layout shift)', () => {
    render(<TeammateGallery value="blank" onChange={vi.fn()} />);
    const blankStyle = cardFor('Start from scratch').getAttribute('style') ?? '';
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
    expect(screen.queryByText('Start from scratch')).not.toBeInTheDocument();

    fireEvent.click(clear as HTMLButtonElement);
    // Reset to All: every card back (blank first) and the button is gone.
    expect(screen.getByText('Start from scratch')).toBeInTheDocument();
    expect(screen.queryByText('Clear filters')).toBeNull();
  });
});
