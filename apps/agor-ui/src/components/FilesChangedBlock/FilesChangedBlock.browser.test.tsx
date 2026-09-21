import type { Message } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { FilesChangedBlock } from './FilesChangedBlock';

afterEach(cleanup);

const patch = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines }];

/** An assistant tool call and its result, as the transcript stores them. */
const call = (
  index: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
  diff?: unknown,
  parentToolUseId?: string
): Message[] =>
  [
    {
      message_id: `${id}-call`,
      session_id: 'session-1',
      role: 'assistant',
      index,
      timestamp: '2026-09-21T00:00:00.000Z',
      parent_tool_use_id: parentToolUseId,
      content: [{ type: 'tool_use', id, name, input }],
    },
    {
      message_id: `${id}-result`,
      session_id: 'session-1',
      role: 'user',
      index: index + 1,
      timestamp: '2026-09-21T00:00:01.000Z',
      parent_tool_use_id: parentToolUseId,
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(diff ? { diff } : {}) }],
    },
  ] as unknown as Message[];

const readCall = call(0, 'r1', 'Read', { file_path: '/repo/Catalog.tsx' });
const editCall = call(
  2,
  'e1',
  'Edit',
  { file_path: '/repo/CatalogTab.tsx' },
  {
    structuredPatch: patch(['-was', '+is', '+also']),
  }
);
/** An edit performed inside the turn's subagent chain. */
const subagentEdit = call(
  4,
  'e2',
  'Write',
  { file_path: '/repo/CatalogCard.tsx' },
  { structuredPatch: patch(['+fresh']) },
  'task-1'
);

describe('Files changed disclosure', () => {
  it('groups a turn into one line and expands to the diffs', async () => {
    render(<FilesChangedBlock messages={[...readCall, ...editCall]} />);

    const toggle = screen.getByRole('button', { name: /CatalogTab\.tsx/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('+2')).toBeVisible();
    expect(screen.getByText('-1')).toBeVisible();
    expect(screen.queryByText('is')).not.toBeInTheDocument();

    await act(async () => userEvent.tab());
    expect(toggle).toHaveFocus();
    await act(async () => userEvent.keyboard('{Enter}'));

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    expect(screen.getByText('is')).toBeVisible();
  });

  it('aggregates edits made inside the turn subagent chain', () => {
    render(<FilesChangedBlock messages={[...editCall, ...subagentEdit]} />);

    expect(screen.getByRole('button', { name: /2 files changed/ })).toBeVisible();
    expect(screen.getByText('+3')).toBeVisible();
    expect(screen.getByText('-1')).toBeVisible();
  });

  it('renders nothing when the turn changed no files', () => {
    const { container } = render(<FilesChangedBlock messages={readCall} />);

    expect(container).toBeEmptyDOMElement();
  });
});
