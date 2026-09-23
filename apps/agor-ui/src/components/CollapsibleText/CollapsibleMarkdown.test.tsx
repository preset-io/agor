import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';

afterEach(cleanup);

it('retains the existing 15-source-line threshold and standalone collapsed default', () => {
  const content = Array.from({ length: 15 }, (_, i) => `Line ${i}`).join('\n');
  const view = render(<CollapsibleMarkdown maxLines={10}>{content}</CollapsibleMarkdown>);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  view.rerender(<CollapsibleMarkdown maxLines={10}>{`${content}\nLine 15`}</CollapsibleMarkdown>);
  const more = screen.getByRole('button', { name: 'show more', expanded: false });
  fireEvent.click(more);
  expect(screen.getByRole('button', { name: 'show less', expanded: true })).toBeInTheDocument();
});
