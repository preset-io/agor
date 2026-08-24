import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelector } from './ModelSelector';

describe('ModelSelector (Claude)', () => {
  it('renders aliases by display name and offers a pin affordance', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    // Closed control shows the friendly display name, not the raw id.
    expect(screen.getByText('Claude Sonnet 5 — 1M')).toBeInTheDocument();
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

  it('updates pin mode when a controlled value changes', () => {
    const pinned = 'claude-sonnet-4-6-20260101';
    const { rerender } = render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );

    rerender(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: pinned }}
      />
    );

    expect(screen.getByRole('combobox')).toHaveValue(pinned);
    expect(screen.getByText('Use a recommended model')).toBeInTheDocument();
  });

  it('switches to exact mode only after a specific version is entered', () => {
    const onChange = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onChange={onChange}
      />
    );
    const pinButton = screen.getByRole('button', { name: 'Pin a specific version…' });
    pinButton.focus();
    expect(pinButton).toHaveFocus();
    fireEvent.click(pinButton);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'claude-sonnet-4-6-20260101' },
    });
    expect(onChange).toHaveBeenCalledWith({
      mode: 'exact',
      model: 'claude-sonnet-4-6-20260101',
    });
  });

  it('wraps option descriptions instead of truncating them', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    // A long model description renders in full and is allowed to wrap.
    expect(screen.getByText(/Frontier model for complex reasoning/)).toHaveStyle({
      whiteSpace: 'normal',
    });
  });

  it('offers previous aliases alongside the preferred models', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));

    expect(screen.getByText('Claude Opus 4.7 — 200k')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 4.7 — 1M')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4.6 — 200k')).toBeInTheDocument();
  });
});

describe('ModelSelector (list variant)', () => {
  it('shows the models directly with a search box, no nested combobox', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        variant="list"
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    // Values are visible immediately as a radio list; the only field is search.
    expect(screen.getByPlaceholderText('Search models…')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(1);
    // Pin stays an unobtrusive expander below the list.
    expect(screen.getByText('Pin a specific version…')).toBeInTheDocument();
  });

  it('filters the list from the search box', () => {
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        variant="list"
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
      />
    );
    const before = screen.getAllByRole('radio').length;
    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'opus' } });
    const after = screen.getAllByRole('radio').length;
    expect(after).toBeLessThan(before);
    expect(screen.getAllByText(/Claude Opus/).length).toBeGreaterThan(0);
  });

  it('applies the picked model and fires onSelect (close-on-select)', () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        variant="list"
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onChange={onChange}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText('Claude Opus 4.7 — 200k'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'alias', model: expect.any(String) })
    );
    expect(onSelect).toHaveBeenCalled();
  });
});

describe('ModelSelector (Codex)', () => {
  it('marks older aliases whose availability depends on the provider account', () => {
    render(<ModelSelector agentic_tool="codex" value={{ mode: 'alias', model: 'gpt-5.6-sol' }} />);

    fireEvent.mouseDown(screen.getByRole('combobox'));

    expect(screen.getAllByText('account-dependent').length).toBeGreaterThan(0);
  });
});
