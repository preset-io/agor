import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ThinkingBlock } from '../ThinkingBlock/ThinkingBlock';
import { ToolBlock } from './ToolBlock';

afterEach(cleanup);

describe('Transcript disclosure keyboard access', () => {
  it.each([false, true])('opens and closes tool output with compact=%s', async (compact) => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <ToolBlock compact={compact} icon={null} name="Read" />
        <ToolBlock compact={compact} icon={null} name="Bash">
          <span>Command output</span>
        </ToolBlock>
      </form>
    );

    // Rows without a body must not introduce a dead tab stop.
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Bash/ });
    await act(async () => userEvent.tab());
    expect(toggle).toHaveFocus();
    expect(getComputedStyle(toggle).outlineStyle).not.toBe('none');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Command output')).not.toBeInTheDocument();

    await act(async () => userEvent.keyboard('{Enter}'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Command output')).toBeVisible();
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toContainElement(
      screen.getByText('Command output')
    );

    await act(async () => userEvent.keyboard(' '));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Command output')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps compact thinking reachable without a pointer', async () => {
    render(<ThinkingBlock compact content="Checking the existing implementation." />);
    const toggle = screen.getByRole('button', { name: /Thought/ });

    await act(async () => userEvent.tab());
    expect(toggle).toHaveFocus();
    await act(async () => userEvent.keyboard(' '));
    expect(screen.getByText('Checking the existing implementation.')).toBeVisible();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await act(async () => userEvent.keyboard('{Enter}'));
    expect(screen.queryByText('Checking the existing implementation.')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
