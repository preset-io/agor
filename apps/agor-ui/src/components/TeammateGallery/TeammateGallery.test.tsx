/**
 * Query style mirrors OnboardingWizard.test.tsx: antd `Tag` + jsdom `cssstyle`
 * crash on accessible-name computation, so this file uses text queries +
 * `closest('[role="radio"]')` instead of `getByRole`.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { TeammateGallery } from './TeammateGallery';

function cardFor(title: string): HTMLElement {
  const card = screen.getByText(title).closest('[role="radio"]');
  if (!card) throw new Error(`No card found for "${title}"`);
  return card as HTMLElement;
}

describe('TeammateGallery', () => {
  it('renders all six templates plus the blank starter as a single-select radiogroup', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);

    expect(screen.getByRole('radiogroup', { name: 'Teammate template' })).toBeInTheDocument();
    for (const title of [
      'Competitive Analyst',
      'Product Manager',
      'Financial Analyst',
      'Deal Desk Analyst',
      'Outbound Analyst',
      'Legal Analyst',
      'Start blank',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
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

    // dig-into-anything → competitive + financial analyst.
    expect(screen.getAllByText('Recommended')).toHaveLength(2);
    expect(cardFor('Competitive Analyst')).toHaveTextContent('Recommended');
    expect(cardFor('Financial Analyst')).toHaveTextContent('Recommended');
    expect(cardFor('Product Manager')).not.toHaveTextContent('Recommended');
    expect(cardFor('Start blank')).not.toHaveTextContent('Recommended');
  });

  it('shows no badge when the selected goals map to no template', () => {
    render(<TeammateGallery goals={['personal-teammate']} value={null} onChange={vi.fn()} />);
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('shows no badge when no goals are supplied', () => {
    render(<TeammateGallery value={null} onChange={vi.fn()} />);
    expect(screen.queryByText('Recommended')).not.toBeInTheDocument();
  });
});
