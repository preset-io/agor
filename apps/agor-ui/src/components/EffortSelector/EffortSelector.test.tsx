import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EffortSelector } from './EffortSelector';

describe('EffortSelector', () => {
  it('shows inherited when unset and only offers supported levels', () => {
    render(
      <EffortSelector
        allowInherited
        levels={['low', 'medium', 'high', 'xhigh']}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText('Inherited')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('X-High')).toBeInTheDocument();
    expect(within(listbox).queryByText('Maximum')).not.toBeInTheDocument();
    expect(within(listbox).queryByText(/default/i)).not.toBeInTheDocument();
  });

  it('uses the caller-provided fallback instead of owning a default', () => {
    render(<EffortSelector fallbackValue="medium" levels={['low', 'medium', 'high']} />);
    expect(screen.getByRole('combobox').parentElement).toHaveTextContent('Medium effort');
  });

  it('clears an explicit override back to inherited', () => {
    const onChange = vi.fn();
    const { container } = render(
      <EffortSelector
        value="medium"
        allowInherited
        levels={['low', 'medium', 'high', 'xhigh']}
        onChange={onChange}
      />
    );

    const select = container.querySelector('.ant-select') as Element;
    fireEvent.mouseEnter(select);
    fireEvent.mouseDown(container.querySelector('.ant-select-clear') as Element);
    expect(onChange.mock.calls.at(-1)?.[0]).toBeUndefined();
  });
});
