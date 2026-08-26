import { act, fireEvent, render, screen } from '@testing-library/react';
import { Button, Popover } from 'antd';
import { useState } from 'react';
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
    expect(screen.getByText('Claude Sonnet 5 · 1M')).toBeInTheDocument();
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

  it('updates exact model text without committing until selection or blur', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
    const pinButton = screen.getByRole('button', { name: 'Pin a specific version…' });
    pinButton.focus();
    expect(pinButton).toHaveFocus();
    fireEvent.click(pinButton);
    expect(onChange).not.toHaveBeenCalled();

    const exactInput = screen.getByRole('combobox');
    for (const model of ['c', 'cl', 'claude-sonnet-4-6-20260101']) {
      fireEvent.change(exactInput, { target: { value: model } });
    }
    expect(exactInput).toHaveValue('claude-sonnet-4-6-20260101');
    expect(onChange).toHaveBeenCalledWith({
      mode: 'exact',
      model: 'claude-sonnet-4-6-20260101',
    });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(exactInput);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      mode: 'exact',
      model: 'claude-sonnet-4-6-20260101',
    });
  });

  it('keeps a real picker open while Tab moves from exact input to recommended mode', () => {
    const onCommit = vi.fn();

    function PickerHarness() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState({
        mode: 'exact' as const,
        model: 'claude-sonnet-4-6-20260101',
      });
      return (
        <>
          <Popover
            open={open}
            onOpenChange={setOpen}
            trigger="click"
            content={
              <ModelSelector
                agentic_tool="claude-code"
                showAdvisor={false}
                value={value}
                onChange={setValue}
                onCommit={(selection) => {
                  onCommit(selection);
                  setOpen(false);
                }}
              />
            }
          >
            <Button aria-label="Model picker" aria-expanded={open}>
              Model
            </Button>
          </Popover>
          <Button aria-label="After picker">After picker</Button>
        </>
      );
    }

    render(<PickerHarness />);
    const trigger = screen.getByRole('button', { name: 'Model picker' });
    fireEvent.click(trigger);

    const exactInput = screen.getByRole('combobox');
    const recommendedMode = screen.getByRole('button', { name: 'Use a recommended model' });
    act(() => exactInput.focus());
    fireEvent.keyDown(exactInput, { key: 'Tab' });
    act(() => recommendedMode.focus());

    expect(recommendedMode).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(onCommit).not.toHaveBeenCalled();

    // Enter activates the focused button in the browser; click represents the
    // resulting activation without replacing the real selector implementation.
    fireEvent.keyDown(recommendedMode, { key: 'Enter' });
    fireEvent.click(recommendedMode);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Claude Fable 5 · 1M'));
    expect(onCommit).toHaveBeenCalledWith({ mode: 'alias', model: 'claude-fable-5' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Re-enter exact mode, then Tab through the mode toggle without activating
    // it. Leaving the whole picker commits once and closes the popover.
    onCommit.mockClear();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Pin a specific version…' }));
    const nextExactInput = screen.getByRole('combobox');
    const nextRecommendedMode = screen.getByRole('button', {
      name: 'Use a recommended model',
    });
    const afterPicker = screen.getByRole('button', { name: 'After picker' });

    act(() => nextExactInput.focus());
    fireEvent.keyDown(nextExactInput, { key: 'Tab' });
    act(() => nextRecommendedMode.focus());
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(nextRecommendedMode, { key: 'Tab' });
    act(() => afterPicker.focus());

    expect(afterPicker).toHaveFocus();
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({ mode: 'exact', model: 'claude-fable-5' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('normalizes exact-model whitespace when focus leaves the picker', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: 'claude-sonnet-5' }}
        onChange={onChange}
        onCommit={onCommit}
      />
    );

    const exactInput = screen.getByRole('combobox');
    fireEvent.change(exactInput, { target: { value: '  claude-fable-5  ' } });
    fireEvent.blur(exactInput);

    expect(onChange).toHaveBeenLastCalledWith({ mode: 'exact', model: 'claude-fable-5' });
    expect(onCommit).toHaveBeenCalledWith({ mode: 'exact', model: 'claude-fable-5' });
  });

  it('commits an alias when the user selects it', () => {
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Claude Fable 5 · 1M'));
    expect(onCommit).toHaveBeenCalledWith({ mode: 'alias', model: 'claude-fable-5' });
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

    expect(screen.getByText('Claude Opus 4.7 · 200k')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 4.7 · 1M')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4.6 · 200k')).toBeInTheDocument();
  });
});

describe('ModelSelector (Codex)', () => {
  it('marks older aliases whose availability depends on the provider account', () => {
    render(<ModelSelector agentic_tool="codex" value={{ mode: 'alias', model: 'gpt-5.6-sol' }} />);

    fireEvent.mouseDown(screen.getByRole('combobox'));

    expect(screen.getAllByText('account-dependent').length).toBeGreaterThan(0);
  });
});
