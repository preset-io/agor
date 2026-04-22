import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThemedSyntaxHighlighter } from './ThemedSyntaxHighlighter';

describe('ThemedSyntaxHighlighter', () => {
  it('renders a block-level <pre> wrapper by default (prevents staircase on wrapped lines)', () => {
    const { container } = render(
      <ThemedSyntaxHighlighter language="yaml" showLineNumbers>
        {'# comment line 1\n# comment line 2\nversion: 2\n'}
      </ThemedSyntaxHighlighter>
    );

    // Assert the *outer* wrapper tag specifically — inner token spans
    // would mask a regression if we searched anywhere in the subtree.
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe('pre');
  });

  it('honors an explicit PreTag override', () => {
    const { container } = render(
      <ThemedSyntaxHighlighter language="bash" PreTag="span">
        {'echo hi'}
      </ThemedSyntaxHighlighter>
    );
    // Check the outer wrapper tag directly — querySelector('span') would
    // pass trivially due to inner token spans even if the wrapper changed.
    expect(container.firstElementChild?.tagName.toLowerCase()).toBe('span');
    expect(container.querySelector('pre')).toBeNull();
  });
});
