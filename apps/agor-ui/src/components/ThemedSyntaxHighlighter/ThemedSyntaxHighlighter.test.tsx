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

    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    // Must not be an inline <code> wrapper — that caused the staircase bug
    // because soft-wrapped long lines flowed inline from the previous line.
    expect(pre?.tagName.toLowerCase()).toBe('pre');
  });

  it('honors an explicit PreTag override', () => {
    const { container } = render(
      <ThemedSyntaxHighlighter language="bash" PreTag="span">
        {'echo hi'}
      </ThemedSyntaxHighlighter>
    );
    // When overridden to span, there should be no <pre> wrapper.
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('span')).not.toBeNull();
  });
});
