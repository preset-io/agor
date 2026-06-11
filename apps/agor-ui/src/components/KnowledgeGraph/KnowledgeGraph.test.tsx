import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KnowledgeGraphDocNodeLabel } from './KnowledgeGraph';

describe('KnowledgeGraphDocNodeLabel', () => {
  it('lays out emoji and title as centered, spaced flex items', () => {
    render(<KnowledgeGraphDocNodeLabel title="Roadmap" iconEmoji="🚀" />);

    const title = screen.getByText('Roadmap');
    const label = title.parentElement;
    if (!label) {
      throw new Error('Expected title to be rendered inside the label wrapper');
    }

    expect(label).toHaveStyle({
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    });
    expect(screen.getByText('🚀')).toHaveStyle({
      display: 'inline-flex',
      alignItems: 'center',
    });
    expect(title).toHaveStyle({ minWidth: '0', flex: '1 1 auto' });
  });
});
