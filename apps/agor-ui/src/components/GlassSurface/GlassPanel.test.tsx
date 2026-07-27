import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { describe, expect, it } from 'vitest';
import { GlassPanel, GlassPanelHighlights } from './GlassPanel';

describe('GlassPanel', () => {
  it('renders optional, clipped highlights behind its content', () => {
    const { container } = render(
      <ConfigProvider>
        <GlassPanel surfaceAlpha={0.75} highlights>
          Panel content
        </GlassPanel>
      </ConfigProvider>
    );

    const panel = container.querySelector('[data-glass-panel="true"]');
    const highlights = container.querySelector('[data-glass-highlights="subtle"]');

    expect(panel).toHaveStyle({ position: 'relative', overflow: 'hidden' });
    expect(highlights).toHaveAttribute('aria-hidden', 'true');
    expect(highlights).toHaveStyle({ pointerEvents: 'none', overflow: 'hidden' });
    expect(container.querySelectorAll('[data-glass-highlight]')).toHaveLength(2);
    expect(screen.getByText('Panel content')).toBeVisible();
    expect(container.querySelector('style')).not.toBeInTheDocument();
  });

  it('keeps animated highlights optional and disables them for reduced motion', () => {
    const { container } = render(<GlassPanelHighlights intensity="strong" animated />);

    expect(container.querySelector('[data-glass-highlights="strong"]')).toBeInTheDocument();
    expect(container.querySelector('[data-glass-highlight="bottom-right"]')).toHaveClass(
      'agor-glass-highlight-primary'
    );
    expect(container.querySelector('[data-glass-highlight="top-left"]')).toHaveClass(
      'agor-glass-highlight-secondary'
    );
    expect(container.querySelector('style')?.textContent).toContain(
      '@media (prefers-reduced-motion: reduce)'
    );
  });
});
