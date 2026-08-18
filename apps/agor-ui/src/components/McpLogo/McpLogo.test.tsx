import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { McpLogo } from './McpLogo';

describe('McpLogo', () => {
  it('renders an inline <svg> brand mark (CSP-safe, not a mask span) for a known MCP', () => {
    render(<McpLogo id="slack" name="Slack" />);
    const el = screen.getByLabelText('Slack logo');
    // Inline SVG tinted via fill=currentColor — nothing fetched, so no CSP dependency.
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.getAttribute('fill')).toBe('currentColor');
    expect(el.querySelector('path')).not.toBeNull();
    expect(el).not.toHaveClass('anticon');
  });

  it('falls back to a neutral AntD icon when the brand path is missing', () => {
    render(<McpLogo id="amplitude" name="Amplitude" />);
    // No brand path bundled for Amplitude → the ApiOutlined fallback carries the label.
    expect(screen.getByLabelText('Amplitude logo')).toHaveClass('anticon');
  });
});
