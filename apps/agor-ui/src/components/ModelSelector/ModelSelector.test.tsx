import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

describe('ModelSelector (Claude)', () => {
  it('renders curated aliases by display name and offers a pin affordance', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    // Closed control shows the friendly display name, not the raw id.
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
    expect(screen.getByText('Pin a specific version…')).toBeInTheDocument();
  });

  it('re-hydrates an exact/pinned model ID into the pin input', () => {
    const pinned = 'claude-sonnet-4-6-20260101';
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: pinned }}
      />
    );
    // Pinned view is active: the exact id is editable and the alias link flips.
    expect(screen.getByRole('combobox')).toHaveValue(pinned);
    expect(screen.getByText('Use a recommended model')).toBeInTheDocument();
    expect(screen.queryByText('Pin a specific version…')).not.toBeInTheDocument();
  });

  it('switches to exact mode when pinning a version', () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByText('Pin a specific version…'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exact' }));
  });
});
