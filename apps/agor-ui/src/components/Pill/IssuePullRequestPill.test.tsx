import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IssuePill, PullRequestPill } from './Pill';

describe('GitHub link pills', () => {
  it.each([
    ['issue', () => <IssuePill issueUrl="https://github.com/preset-io/agor/issues/42" />],
    ['pull request', () => <PullRequestPill prUrl="https://github.com/preset-io/agor/pull/43" />],
  ])('renders the %s pill as a keyboard-focusable link', (_name, renderPill) => {
    render(renderPill());

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).not.toHaveAttribute('tabindex', '-1');
    expect(link.firstElementChild).toHaveStyle({ cursor: 'pointer' });
  });
});
