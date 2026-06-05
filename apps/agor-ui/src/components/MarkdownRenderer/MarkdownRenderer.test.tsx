import { render, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer';

// Regression harness for Streamdown's internal memoization behavior: this fake
// renderer intentionally keeps the first children it receives until React
// remounts it. MarkdownRenderer should force a remount for non-streaming content
// changes so editor previews cannot get stuck on stale markdown.
vi.mock('streamdown', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');

  return {
    Streamdown: ({ children }: { children: React.ReactNode }) => {
      const [initialChildren] = ReactModule.useState(children);
      return ReactModule.createElement('div', { 'data-testid': 'streamdown' }, initialChildren);
    },
  };
});

describe('MarkdownRenderer', () => {
  it('remounts the non-streaming markdown renderer when content changes', () => {
    const { rerender } = render(<MarkdownRenderer content="- and reusable prompts." />);

    expect(screen.getByTestId('streamdown')).toHaveTextContent('- and reusable prompts.');

    rerender(<MarkdownRenderer content="- and reusable prompts.updated" />);

    expect(screen.getByTestId('streamdown')).toHaveTextContent('- and reusable prompts.updated');
  });
});
