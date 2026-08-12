import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { McpLogo } from './McpLogo';

describe('McpLogo', () => {
  it('renders a brand mask (not the fallback icon) for a known MCP', () => {
    render(<McpLogo id="slack" name="Slack" />);
    const el = screen.getByLabelText('Slack logo');
    expect(el).toBeInTheDocument();
    expect(el).not.toHaveClass('anticon');
  });

  it('falls back to a neutral AntD icon when the brand asset is missing', () => {
    render(<McpLogo id="amplitude" name="Amplitude" />);
    // No brand asset bundled for Amplitude → the ApiOutlined fallback carries the label.
    expect(screen.getByLabelText('Amplitude logo')).toHaveClass('anticon');
  });
});
