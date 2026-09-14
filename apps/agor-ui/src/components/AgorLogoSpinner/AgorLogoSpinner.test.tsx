// biome-ignore-all lint/plugin/noHardcodedColorLiteral: distinctive literal verifies the color override prop propagates
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgorLogoSpinner } from './AgorLogoSpinner';

describe('AgorLogoSpinner', () => {
  it('renders the full logo geometry as an accessible loading image', () => {
    const { container } = render(<AgorLogoSpinner />);

    const svg = screen.getByRole('img', { name: 'Loading' });
    expect(svg).toBeInTheDocument();
    // Static A + crossbar, spinner ring, two orbit tails, four dots.
    expect(container.querySelectorAll('path')).toHaveLength(4);
    expect(container.querySelectorAll('circle')).toHaveLength(5);
    expect(container.querySelector('.agor-logo-spinner-ring')).toBeInTheDocument();
    expect(container.querySelectorAll('.agor-logo-spinner-tail')).toHaveLength(2);
  });

  it('honors size and color overrides', () => {
    render(<AgorLogoSpinner size={48} color="#123456" aria-label="Loading boards" />);

    const svg = screen.getByRole('img', { name: 'Loading boards' });
    expect(svg).toHaveAttribute('width', '48');
    expect(svg).toHaveAttribute('height', '48');
    expect(svg).toHaveStyle({ color: '#123456' });
  });
});
