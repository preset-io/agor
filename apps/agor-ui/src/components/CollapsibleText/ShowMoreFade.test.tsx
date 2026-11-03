import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CollapsibleAnsiText } from './CollapsibleAnsiText';
import { CollapsibleText } from './CollapsibleText';

afterEach(cleanup);

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n');

it('fades a collapsed preview with a mask, no ellipsis line, and toggles in place', () => {
  const { container } = render(<CollapsibleText>{lines(42)}</CollapsibleText>);
  const more = screen.getByRole('button', { name: 'Show more', expanded: false });
  const content = document.getElementById(more.getAttribute('aria-controls')!)!;
  expect(content.style.maskImage).toMatch(/calc\(100% - 48px\),\s?transparent\)$/);
  expect(container).not.toHaveTextContent('…');
  expect(container).not.toHaveTextContent('more lines');
  expect(container).not.toHaveTextContent('line 41');

  fireEvent.click(more);
  const less = screen.getByRole('button', { name: 'Show less', expanded: true });
  expect(less).toBe(more);
  expect(content.style.maskImage).toBe('');
  expect(container).toHaveTextContent('line 41');
});

it('counts every line for tool output and leaves short output alone', () => {
  const view = render(<CollapsibleAnsiText>{lines(42)}</CollapsibleAnsiText>);
  expect(screen.getByRole('button', { name: 'Show all 42 lines' })).toBeInTheDocument();
  view.rerender(<CollapsibleText code>{lines(42)}</CollapsibleText>);
  expect(screen.getByRole('button', { name: 'Show all 42 lines' })).toBeInTheDocument();
  view.rerender(<CollapsibleAnsiText>{lines(12)}</CollapsibleAnsiText>);
  expect(screen.queryByRole('button')).toBeNull();
});
