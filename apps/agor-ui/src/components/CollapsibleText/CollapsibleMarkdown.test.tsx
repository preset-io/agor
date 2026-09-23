import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';

afterEach(cleanup);

it('collapses a long single paragraph but not short multiline text', () => {
  const short = Array.from({ length: 15 }, (_, i) => `Line ${i}`).join('\n');
  const view = render(<CollapsibleMarkdown>{short}</CollapsibleMarkdown>);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  const paragraph = 'Long paragraph '.repeat(150) + 'Complete tail';
  view.rerender(<CollapsibleMarkdown>{paragraph}</CollapsibleMarkdown>);
  expect(screen.queryByText(paragraph)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'show more', expanded: false }));
  expect(screen.getByText(paragraph)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'show less', expanded: true })).toBeInTheDocument();
});

it('repairs cut emphasis without exposing syntax markers, then renders the full original', () => {
  const markdown = '**' + 'bold words '.repeat(250).trimEnd() + '**';
  const view = render(<CollapsibleMarkdown>{markdown}</CollapsibleMarkdown>);
  expect(view.container.querySelector('[data-streamdown="strong"]')).not.toBeNull();
  expect(view.container.textContent).not.toContain('**');
  fireEvent.click(screen.getByRole('button', { name: 'show more' }));
  expect(view.container.querySelector('[data-streamdown="strong"]')?.textContent).toBe(
    'bold words '.repeat(250).trimEnd()
  );
});

it('does not turn a truncated URL into a navigable destination', () => {
  const url = `https://example.com/${'a'.repeat(2400)}`;
  const markdown = 'Intro '.repeat(95) + `[Link](${url})`;
  render(<CollapsibleMarkdown>{markdown}</CollapsibleMarkdown>);
  expect(screen.queryByRole('link', { name: 'Link' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'show more' }));
  expect(screen.getByRole('link', { name: 'Link' })).toHaveAttribute('href', url);
});
