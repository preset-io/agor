import type { Message } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentChain } from './AgentChain';

/** One thought, one Read of one file, one errored Bash. */
function chainMessages(): Message[] {
  return [
    {
      message_id: 'm1',
      role: 'assistant',
      index: 0,
      timestamp: '2026-09-20T00:00:00.000Z',
      content: [
        { type: 'text', text: 'Checking the catalog tab' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/CatalogTab.tsx' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test' } },
      ],
    },
    {
      message_id: 'm2',
      role: 'user',
      index: 1,
      timestamp: '2026-09-20T00:01:14.000Z',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: '' },
        { type: 'tool_result', tool_use_id: 't2', content: '', is_error: true },
      ],
    },
  ] as unknown as Message[];
}

describe('AgentChain compact view', () => {
  it('collapses the chain to one summary line that expands to the steps', () => {
    render(<AgentChain messages={chainMessages()} compact isLatest={false} />);

    // 1 thought + 2 tools over 1m 14s, touching one file.
    const summary = screen.getByText('Worked for 1m 14s · 3 steps · 1 file');
    expect(summary).toBeVisible();
    expect(screen.getByText('· 1 retried')).toBeVisible();
    expect(screen.queryByText('Checking the catalog tab')).not.toBeInTheDocument();

    fireEvent.click(summary);

    expect(screen.getByText('Checking the catalog tab')).toBeVisible();
    expect(screen.getByText('Read')).toBeVisible();
    expect(screen.getByText('Bash')).toBeVisible();
  });

  it('leaves the detailed chain summary untouched', () => {
    render(<AgentChain messages={chainMessages()} isLatest={false} />);

    // Detailed still opens straight into the step list, with no summary line.
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();
    expect(screen.getByText('Checking the catalog tab')).toBeVisible();
  });
});
