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
    const onCommit = vi.fn();
    const { rerender } = render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    rerender(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: pinned }}
        onCommit={onCommit}
      />
    );

    expect(screen.getByRole('combobox')).toHaveValue(pinned);
    expect(screen.getByText('Use a recommended model')).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('filters aliases without change or commit on first mount and remount', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const picker = (
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias' as const, model: 'claude-sonnet-5' }}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
    const first = render(picker);

    let input = screen.getByRole('combobox');
    fireEvent.mouseDown(input);
    for (const query of ['f', 'fa', 'fable']) {
      fireEvent.change(input, { target: { value: query } });
    }
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    first.unmount();
    render(picker);
    input = screen.getByRole('combobox');
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: 'sonnet' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
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

  it('does not commit an unchanged exact model on blur', () => {
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    const input = screen.getByRole('combobox');
    fireEvent.blur(input);
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels a dirty exact-model draft on Escape without committing on blur', () => {
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'claude-fable-5' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(input).toHaveValue('claude-sonnet-5');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('restores the pre-edit baseline through a controlled parent on Escape', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState({
        mode: 'exact' as const,
        model: 'claude-sonnet-5',
      });
      return (
        <ModelSelector
          agentic_tool="claude-code"
          showAdvisor={false}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onCommit={onCommit}
        />
      );
    }

    render(<ControlledPicker />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'claude-fable-5' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);

    expect(input).toHaveValue('claude-sonnet-5');
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'exact',
      model: 'claude-sonnet-5',
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('restores recommended mode when cancelling a newly enabled pin draft', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState({
        mode: 'alias' as const,
        model: 'claude-sonnet-5',
      });
      return (
        <ModelSelector
          agentic_tool="claude-code"
          showAdvisor={false}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          onCommit={onCommit}
        />
      );
    }

    render(<ControlledPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin a specific version…' }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'claude-fable-5' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByText('Claude Sonnet 5 · 1M')).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'alias',
      model: 'claude-sonnet-5',
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('clears a blank exact draft and accepts the next realtime model', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { rerender } = render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: 'claude-sonnet-5' }}
        onChange={onChange}
        onCommit={onCommit}
      />
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);

    expect(input).toHaveValue('claude-sonnet-5');
    expect(onCommit).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'exact',
      model: 'claude-sonnet-5',
    });

    const realtimeModel = 'claude-fable-5';
    rerender(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: realtimeModel }}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
    expect(input).toHaveValue(realtimeModel);
  });

  it('does not commit an unfinished exact-model draft when unmounted', () => {
    const onCommit = vi.fn();
    const view = render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'exact', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'claude-fable-5' },
    });
    view.unmount();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits one advisor selection with a pending exact draft and no blur duplicate', () => {
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        value={{ mode: 'exact', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    const [exactInput, advisorInput] = screen.getAllByRole('combobox');
    fireEvent.change(exactInput, { target: { value: 'claude-custom-20260828' } });
    fireEvent.mouseDown(advisorInput);
    fireEvent.click(screen.getAllByText('Claude Fable 5 · 1M').at(-1)!);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith({
      mode: 'exact',
      model: 'claude-custom-20260828',
      advisorModel: 'claude-fable-5',
    });

    fireEvent.blur(advisorInput);
    fireEvent.blur(exactInput);
    expect(onCommit).toHaveBeenCalledOnce();
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

  it('commits one keyboard-selected alias on Enter', () => {
    const onCommit = vi.fn();
    render(
      <ModelSelector
        agentic_tool="claude-code"
        showAdvisor={false}
        value={{ mode: 'alias', model: 'claude-sonnet-5' }}
        onCommit={onCommit}
      />
    );

    const input = screen.getByRole('combobox');
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: 'fable' } });
    fireEvent.keyDown(input, { key: 'ArrowDown', keyCode: 40, which: 40 });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, which: 13 });

    expect(onCommit).toHaveBeenCalledOnce();
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
    expect(screen.getByText(/Most capable model for demanding reasoning/)).toHaveStyle({
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
