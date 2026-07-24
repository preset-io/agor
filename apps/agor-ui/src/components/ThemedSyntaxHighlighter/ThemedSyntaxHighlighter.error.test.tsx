import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ThemedSyntaxHighlighter.inner', () => ({
  default: function MockThemedSyntaxHighlighterInner(): never {
    throw new TypeError(
      'Failed to fetch dynamically imported module: http://localhost/ThemedSyntaxHighlighter.inner.tsx'
    );
  },
}));

import { ThemedSyntaxHighlighter } from './ThemedSyntaxHighlighter';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ThemedSyntaxHighlighter lazy-load failure', () => {
  it('falls back to plain code without replacing the surrounding conversation', async () => {
    const { container } = render(
      <div>
        <span>Conversation remains available</span>
        <ThemedSyntaxHighlighter language="typescript">
          {'const answer = 42;'}
        </ThemedSyntaxHighlighter>
      </div>
    );

    expect(await screen.findByText('const answer = 42;')).toBeInTheDocument();
    expect(screen.getByText('Conversation remains available')).toBeInTheDocument();
    expect(container.querySelector('pre')).toHaveTextContent('const answer = 42;');
  });
});
