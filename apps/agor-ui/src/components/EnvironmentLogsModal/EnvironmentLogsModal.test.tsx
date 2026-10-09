/**
 * Regression tests for EnvironmentLogsModal.
 *
 * Bug: opening the logs modal with non-empty log content sometimes crashed
 * the entire app with "Minified React error #130" ("Element type is invalid:
 * ... got: object"). Root cause was the `ansi-to-react` default export
 * resolving to `{ default: Component }` (double-wrapped) under bundler CJS
 * interop, so `<Ansi>` was rendered with an object as its element type.
 *
 * Empty-log branches never tripped the bug because `<Ansi>` is only mounted
 * when `logs.logs` is non-empty; the conditional was the only thing keeping
 * the modal alive on a fresh branch.
 */

import type { BranchEnvironmentInstance } from '@agor/core/types';
import type { AgorClient, Branch } from '@agor-live/client';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { Ansi } from '../AnsiText';
import { EnvironmentLogsModal } from './EnvironmentLogsModal';

function render(ui: ReactNode) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
  });
}

const mockBranch: Partial<Branch> = {
  branch_id: 'wt-test' as Branch['branch_id'],
  name: 'test-branch',
  logs_command: 'preview logs',
};

function makeClient(response: unknown): AgorClient {
  return {
    service: () => ({
      find: vi.fn().mockResolvedValue(response),
    }),
  } as unknown as AgorClient;
}

describe('EnvironmentLogsModal', () => {
  afterEach(cleanup);

  beforeEach(() => {
    __setAuthConfigForTests({ requireAuth: true });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });
  it('safe Ansi import resolves to a callable component (defends against CJS double-default)', async () => {
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
      <EnvironmentLogsModal open onClose={() => {}} branch={mockBranch as Branch} client={client} />
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
      <EnvironmentLogsModal open onClose={() => {}} branch={mockBranch as Branch} client={client} />
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
      <EnvironmentLogsModal open onClose={() => {}} branch={mockBranch as Branch} client={client} />
    );

    await waitFor(async () => {
      const node = await findByText('No logs yet.');
      expect(node).toBeInTheDocument();
    });
  });

  it.each([
    {
      shape: 'an error in the response',
      first: (find: ReturnType<typeof vi.fn>) =>
        find.mockResolvedValueOnce({ logs: '', timestamp: 'then', error: 'Provider down' }),
      raw: 'Provider down',
    },
    {
      shape: 'a rejected request',
      first: (find: ReturnType<typeof vi.fn>) => find.mockRejectedValueOnce(new Error('timeout')),
      raw: 'timeout',
    },
  ])(
    'shows a load error for $shape and clears it after Try again succeeds',
    async ({ first, raw }) => {
      const find = vi.fn();
      first(find).mockResolvedValue({ logs: 'Back up', timestamp: 'now' });
      render(
        <EnvironmentLogsModal
          open
          onClose={() => {}}
          branch={mockBranch as Branch}
          client={{ service: () => ({ find }) } as unknown as AgorClient}
        />
      );
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveAttribute('data-notice-type', 'error');
      expect(within(alert).getByText("Couldn't load the logs.")).toBeInTheDocument();
      fireEvent.click(within(alert).getByRole('button', { name: /Details/ }));
      expect(within(alert).getByText(raw)).toBeInTheDocument();
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.getByText('Back up')).toBeVisible());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    }
  );

  it('shows truncation as a neutral note with the shown line count', async () => {
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={mockBranch as Branch}
        client={makeClient({ logs: 'a\nb\nc', timestamp: '2026-05-10T12:00:00Z', truncated: true })}
      />
    );
    const note = await screen.findByText('Showing the last 3 lines.');
    expect(note.closest('[data-notice-type]')).toHaveAttribute('data-notice-type', 'neutral');
  });

  const failed: BranchEnvironmentInstance = {
    status: 'error',
    command_attempt: {
      id: 'attempt-a',
      action: 'start',
      requested_by: 'user-a' as NonNullable<
        BranchEnvironmentInstance['command_attempt']
      >['requested_by'],
      requested_at: '2026-10-02T21:47:26Z',
      claimed_at: '2026-10-02T21:47:28Z',
      finished_at: '2026-10-02T21:47:30Z',
      claim_deadline: '2026-10-02T21:50:26Z',
      command_deadline: '2026-10-02T21:52:28Z',
      result_deadline: '2026-10-02T21:56:01Z',
      output: 'Cannot resolve the pushed public GitHub branch. Push it before Start.',
      output_truncated: true,
    },
    last_command: {
      action: 'start',
      status: 'failed',
      timestamp: '2026-10-02T21:47:30Z',
      message: 'start command exited with code 1',
    },
  };

  it('opens failed launch output first and keeps it separate from runtime logs', async () => {
    const find = vi.fn().mockResolvedValue({
      logs: 'No owned service exists for this branch. Nothing was changed.',
      timestamp: '2026-10-02T21:48:00Z',
    });
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={{ ...mockBranch, environment_instance: failed } as Branch}
        client={client}
      />
    );
    expect(screen.getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByText(/Cannot resolve the pushed/)).toBeVisible());
    await waitFor(() => expect(screen.getByText('Command output truncated.')).toBeVisible());
    expect(find).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    await waitFor(() => expect(screen.getByText(/No owned service exists/)).toBeVisible());
    expect(find).toHaveBeenCalledWith({ query: { branch_id: mockBranch.branch_id } });
    fireEvent.click(screen.getByRole('tab', { name: 'Commands' }));
    await waitFor(() => expect(screen.getByText(/Cannot resolve the pushed/)).toBeVisible());
  });

  it('keeps command output available without a runtime logs command', async () => {
    const find = vi.fn();
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={{ ...mockBranch, logs_command: undefined, environment_instance: failed } as Branch}
        client={{ service: () => ({ find }) } as unknown as AgorClient}
      />
    );
    await waitFor(() => expect(screen.getByText(/Cannot resolve the pushed/)).toBeVisible());
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    await waitFor(() => expect(screen.getByText('No logs command set up.')).toBeVisible());
    expect(find).not.toHaveBeenCalled();
  });

  it('shows command output when the runtime endpoint fails', async () => {
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={{ ...mockBranch, environment_instance: failed } as Branch}
        client={makeClient({
          logs: '',
          error: 'Provider unavailable',
          timestamp: '2026-10-02T21:48:00Z',
        })}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the logs.");
    fireEvent.click(screen.getByRole('tab', { name: 'Commands' }));
    await waitFor(() => expect(screen.getByText(/Cannot resolve the pushed/)).toBeVisible());
  });

  it('keeps completed command output accessible when shell logs are disabled', async () => {
    __setAuthConfigForTests(
      { requireAuth: true },
      {
        environmentCommands: {
          asynchronous: true,
          shellLogs: false,
          shellLogsReason: 'Shell logs disabled.',
        },
      }
    );
    const find = vi.fn();
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={
          {
            ...mockBranch,
            environment_instance: {
              status: 'starting',
              last_command: {
                action: 'start',
                status: 'succeeded',
                timestamp: '2026-10-02T21:48:00Z',
                output: 'Deployment admitted',
              },
            },
          } as Branch
        }
        client={{ service: () => ({ find }) } as unknown as AgorClient}
      />
    );
    await waitFor(() => expect(screen.getByText('Start completed')).toBeVisible());
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Runtime' }));
    await waitFor(() => expect(screen.getByText('Shell logs disabled.')).toBeVisible());
    expect(find).not.toHaveBeenCalled();
  });

  it('collapses older attempts and updates active command output from branch props', async () => {
    const active: BranchEnvironmentInstance = {
      ...failed,
      status: 'starting',
      command_attempt: {
        ...failed.command_attempt!,
        id: 'attempt-b',
        finished_at: undefined,
        output: 'New launch pending',
        output_truncated: false,
      },
      command_history: [{ attempt: failed.command_attempt!, result: failed.last_command }],
    };
    const props = { open: true, onClose: () => {}, client: null };
    const { rerender } = render(
      <EnvironmentLogsModal
        {...props}
        branch={{ ...mockBranch, environment_instance: active } as Branch}
      />
    );
    await waitFor(() => expect(screen.getByText('Start executing')).toBeVisible());
    expect(screen.queryByText(/Cannot resolve the pushed/)).not.toBeInTheDocument();
    expect(screen.queryByText('start command exited with code 1')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Result deadline:/)).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: /Previous start failed/ }));
    await waitFor(() => expect(screen.getByText(/Cannot resolve the pushed/)).toBeVisible());
    rerender(
      <EnvironmentLogsModal
        {...props}
        branch={
          {
            ...mockBranch,
            environment_instance: {
              ...active,
              command_attempt: { ...active.command_attempt!, output: 'Build admitted' },
            },
          } as Branch
        }
      />
    );
    await waitFor(() => expect(screen.getByText('Build admitted')).toBeVisible());
  });

  it('keeps Commands selected after completion and chooses a fresh default on reopening', async () => {
    const active: Branch = {
      ...mockBranch,
      environment_instance: {
        status: 'starting',
        command_attempt: { ...failed.command_attempt!, finished_at: undefined },
      },
    } as Branch;
    const completed: Branch = {
      ...active,
      environment_instance: {
        status: 'running',
        command_attempt: { ...failed.command_attempt!, output: 'Preview ready' },
        last_command: { ...failed.last_command!, status: 'succeeded' },
      },
    };
    const find = vi.fn().mockResolvedValue({ logs: 'Runtime ready', timestamp: 'now' });
    const props = {
      onClose: () => {},
      client: { service: () => ({ find }) } as unknown as AgorClient,
    };
    const { rerender } = render(<EnvironmentLogsModal {...props} open branch={active} />);
    expect(screen.getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
    rerender(<EnvironmentLogsModal {...props} open branch={completed} />);
    expect(screen.getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByText('Preview ready')).toBeVisible());
    expect(find).not.toHaveBeenCalled();
    rerender(<EnvironmentLogsModal {...props} open={false} branch={completed} />);
    rerender(<EnvironmentLogsModal {...props} open branch={completed} />);
    expect(screen.getByRole('tab', { name: 'Runtime' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByText('Runtime ready')).toBeVisible());
  });

  it('renders legacy output and unknown outcomes without treating them as app health', async () => {
    const legacy: BranchEnvironmentInstance = {
      status: 'error',
      last_command: {
        action: 'stop',
        status: 'unknown',
        timestamp: '2026-10-02T21:48:00Z',
        output: '<img src=x onerror=alert(1)>',
      },
    };
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={{ ...mockBranch, environment_instance: legacy } as Branch}
        client={null}
      />
    );
    await waitFor(() =>
      expect(
        screen
          .getByText("Agor couldn't confirm how this command ended. The output may be incomplete.")
          .closest('[data-notice-type]')
      ).toHaveAttribute('data-notice-type', 'warning')
    );
    expect(screen.queryByText('Stop outcome unknown')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible());
    expect(document.querySelector('img')).toBeNull();
  });

  it.each([
    {
      name: 'shows a failed start as an error notice with its result under Details',
      environment: failed,
      visible: ["The environment didn't start."],
      hidden: ['Start failed', 'start command exited with code 1'],
      noticeType: 'error',
    },
    {
      name: 'shows a failed nuke as an error notice',
      environment: {
        status: 'error',
        last_command: { action: 'nuke', status: 'failed', timestamp: '2026-10-02T21:48:00Z' },
      },
      visible: ["The nuke didn't finish."],
      hidden: ['Nuke failed'],
      noticeType: 'error',
    },
    {
      name: 'shows last_error as an error, not as command output, while the status is error',
      environment: { status: 'error', last_error: 'spawn ENOENT' },
      visible: ['The environment reported an error.'],
      hidden: ['spawn ENOENT', 'Environment error'],
      noticeType: 'error',
    },
    {
      name: 'hides a stale last_error once the status leaves error',
      environment: { status: 'stopped', last_error: 'spawn ENOENT' },
      visible: ['No command history.'],
      hidden: ['spawn ENOENT', 'The environment reported an error.'],
      noticeType: undefined,
    },
  ] satisfies Array<{
    name: string;
    environment: BranchEnvironmentInstance;
    visible: string[];
    hidden: string[];
    noticeType: string | undefined;
  }>)('$name', async ({ environment, visible, hidden, noticeType }) => {
    render(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={
          { ...mockBranch, logs_command: undefined, environment_instance: environment } as Branch
        }
        client={null}
      />
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Commands' }));
    for (const text of visible) await waitFor(() => expect(screen.getByText(text)).toBeVisible());
    for (const text of hidden) expect(screen.queryByText(text)).not.toBeInTheDocument();
    if (noticeType) {
      expect(screen.getByText(visible[0]).closest('[data-notice-type]')).toHaveAttribute(
        'data-notice-type',
        noticeType
      );
    }
  });

  it('does not expose another branch’s retained output or late runtime response', async () => {
    let finishOld!: (value: unknown) => void;
    const find = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockResolvedValue({ logs: 'Branch B runtime', timestamp: '2026-10-02T21:48:00Z' });
    const client = { service: () => ({ find }) } as unknown as AgorClient;
    const { rerender } = render(
      <EnvironmentLogsModal open onClose={() => {}} branch={mockBranch as Branch} client={client} />
    );
    rerender(
      <EnvironmentLogsModal
        open
        onClose={() => {}}
        branch={{ ...mockBranch, branch_id: 'branch-b' } as Branch}
        client={client}
      />
    );
    await waitFor(() => expect(screen.getByText('Branch B runtime')).toBeVisible());
    await act(async () =>
      finishOld({ logs: 'Branch A private output', timestamp: '2026-10-02T21:48:00Z' })
    );
    expect(screen.queryByText('Branch A private output')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Commands' }));
    await waitFor(() => expect(screen.getByText('No command history.')).toBeVisible());
  });
});
