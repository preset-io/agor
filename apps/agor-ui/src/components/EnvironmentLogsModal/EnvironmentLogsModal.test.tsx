/**
 * Regression tests for EnvironmentLogsModal.
 *
 * Bug: opening the logs modal with non-empty log content sometimes crashed
 * the entire app with "Minified React error #130" ("Element type is invalid:
 * ... got: object"). Root cause was the `ansi-to-react` default export
 * resolving to `{ default: Component }` (double-wrapped) under bundler CJS
 * interop, so `<Ansi>` was rendered with an object as its element type.
 *
 * Empty-log worktrees never tripped the bug because `<Ansi>` is only mounted
 * when `logs.logs` is non-empty; the conditional was the only thing keeping
 * the modal alive on a fresh worktree.
 */

import type { AgorClient, Worktree } from '@agor-live/client';
import { render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Ansi } from '../AnsiText';
import { EnvironmentLogsModal } from './EnvironmentLogsModal';

const mockWorktree: Partial<Worktree> = {
  worktree_id: 'wt-test' as Worktree['worktree_id'],
  name: 'test-worktree',
};

function makeClient(response: unknown): AgorClient {
  return {
    service: () => ({
      find: vi.fn().mockResolvedValue(response),
    }),
  } as unknown as AgorClient;
}

describe('EnvironmentLogsModal', () => {
  it('safe Ansi import resolves to a callable component (defends against CJS double-default)', () => {
    // Direct unit assertion: even if ansi-to-react ever ships a double-wrapped
    // default again, the wrapper unwraps it. If this fails, every <Ansi>
    // render in the app is a React #130 timebomb.
    expect(typeof Ansi).toBe('function');
  });

  it('renders non-empty log content without crashing', async () => {
    const client = makeClient({
      logs: 'Server started on port 3000\nReady to accept connections',
      timestamp: new Date('2026-05-10T12:00:00Z').toISOString(),
      truncated: false,
    });

    const { findByText } = render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        worktree={mockWorktree as Worktree}
        client={client}
      />
    );

    // The log body is rendered inside an antd Modal portal, so query against
    // the document and assert the content (and importantly, no crash).
    await waitFor(async () => {
      const node = await findByText(/Server started on port 3000/);
      expect(node).toBeInTheDocument();
    });
  });

  it('renders ANSI-coloured log content without crashing', async () => {
    // Real-world reproduction: process output with ANSI escape codes routed
    // through the `<Ansi>` component is the exact path the original crash
    // took. With the broken import this throws React #130 at mount time.
    const client = makeClient({
      logs: '[32mINFO[0m server up\n[31mERROR[0m oh no',
      timestamp: new Date('2026-05-10T12:00:00Z').toISOString(),
      truncated: false,
    });

    const { findByText } = render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        worktree={mockWorktree as Worktree}
        client={client}
      />
    );

    await waitFor(async () => {
      const info = await findByText(/INFO/);
      expect(info).toBeInTheDocument();
    });
  });

  it('renders the empty-logs placeholder when logs string is empty', async () => {
    const client = makeClient({
      logs: '',
      timestamp: new Date('2026-05-10T12:00:00Z').toISOString(),
    });

    const { findByText } = render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        worktree={mockWorktree as Worktree}
        client={client}
      />
    );

    await waitFor(async () => {
      const node = await findByText(/\(no logs\)/);
      expect(node).toBeInTheDocument();
    });
  });

  it('renders error state with the daemon-supplied error message', async () => {
    const client = makeClient({
      logs: '',
      timestamp: new Date('2026-05-10T12:00:00Z').toISOString(),
      error: 'No logs command configured',
    });

    const { findByRole } = render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        worktree={mockWorktree as Worktree}
        client={client}
      />
    );

    // Assert the antd Alert is rendered with the message (regression on the
    // earlier `title` typo, which made the alert empty).
    const alert = await findByRole('alert');
    expect(within(alert).getByText('Error fetching logs')).toBeInTheDocument();
    expect(within(alert).getByText(/No logs command configured/)).toBeInTheDocument();
  });
});
