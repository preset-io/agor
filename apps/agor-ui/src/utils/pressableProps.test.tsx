import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pressableProps } from './pressableProps';

describe('pressableProps', () => {
  it('activates on click, Enter and Space, and exposes button semantics', () => {
    const onActivate = vi.fn();
    render(<div {...pressableProps(onActivate)}>row</div>);
    const row = screen.getByRole('button', { name: 'row' });
    expect(row).toHaveAttribute('tabindex', '0');

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it('leaves keys pressed on a nested control to that control', () => {
    const onActivate = vi.fn();
    render(
      <div {...pressableProps(onActivate)}>
        <button type="button">nested</button>
      </div>
    );
    const notPrevented = fireEvent.keyDown(screen.getByText('nested'), { key: 'Enter' });
    expect(onActivate).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});
