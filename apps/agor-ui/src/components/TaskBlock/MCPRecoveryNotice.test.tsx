// @vitest-environment jsdom

import { type AgorClient, type MCPRuntimeRecovery, type Task, TaskStatus } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MCPRecoveryNotice } from './TaskBlock';

function recovery(overrides: Partial<MCPRuntimeRecovery> = {}): MCPRuntimeRecovery {
  return {
    generation: 3,
    code: 'stale_capability',
    status: 'action_required',
    task_id: 'task-1',
    session_id: 'session-1',
    provider: {
      mode: 'in_place',
      transport_reload: true,
      retries_unstarted_call: false,
    },
    action: 'reconnect_mcp',
    message: 'Authority changed before provider dispatch.',
    observed_at: '2026-08-25T00:00:00.000Z',
    provider_dispatch: 'not_started',
    ...overrides,
  } as MCPRuntimeRecovery;
}

describe('MCPRecoveryNotice', () => {
  it('submits the durable generation through the one-click reconnect route', async () => {
    const create = vi.fn().mockResolvedValue({ status: 'refresh_requested' });
    const service = vi.fn(() => ({ create }));
    render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery()}
        client={{ service } as unknown as AgorClient}
        canRequestReconnect
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect MCP for this active task' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ generation: 3 }));
    expect(service).toHaveBeenCalledWith('/tasks/task-1/mcp-reconnect');
  });

  it('does not claim hot reload for a next-turn-only provider', () => {
    render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery({
          action: 'retry_next_turn',
          provider: {
            mode: 'next_turn',
            transport_reload: false,
            retries_unstarted_call: false,
          },
          message: 'This provider applies current MCP authority on the next turn.',
        })}
      />
    );

    expect(screen.getByText('MCP updates apply next turn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reconnect MCP/i })).toBeNull();
  });

  it('does not offer reconnect after the Task stops', () => {
    render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.STOPPED } as Task}
        recovery={recovery()}
        client={{ service: vi.fn() } as unknown as AgorClient}
        canRequestReconnect
      />
    );
    expect(screen.queryByText('MCP configuration changed')).toBeNull();
  });

  it('keeps the sole recovery action persistent and advances to a named sign-in action', () => {
    const { rerender } = render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery({
          status: 'refresh_requested',
          request_id: 'request-1',
          refresh_deadline_at: '2026-08-25T00:00:01.000Z',
        })}
        client={{ service: vi.fn() } as unknown as AgorClient}
      />
    );

    expect(screen.getByText('MCP reconnect needs confirmation')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button', { name: 'close' })).toBeNull();

    rerender(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery({
          generation: 3,
          status: 'action_required',
          code: 'oauth_reauth_required',
          action: 'reauthenticate',
          message: 'Sign in again.',
          mcp_server_id: 'server-1',
          mcp_server_name: 'Calendar',
        })}
      />
    );
    expect(screen.getByText('MCP sign-in required')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in to Calendar' })).toHaveAttribute(
      'href',
      '/settings/mcp/server-1/'
    );
  });

  it('announces a failed provider refresh with error severity', () => {
    render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery({ status: 'failed', code: 'provider_refresh_failed' })}
      />
    );
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText('MCP reconnect failed')).toBeTruthy();
  });

  it('clears a stale reconnect error when the durable recovery identity advances', async () => {
    const client = {
      service: vi.fn(() => ({ create: vi.fn().mockRejectedValue(new Error('stale')) })),
    } as unknown as AgorClient;
    const { rerender } = render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery()}
        client={client}
        canRequestReconnect
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect MCP for this active task' }));
    await screen.findByText(/could not be requested/);

    rerender(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery({ generation: 4, message: 'New authority requires attention.' })}
        client={client}
        canRequestReconnect
      />
    );
    await waitFor(() => expect(screen.queryByText(/could not be requested/)).toBeNull());
    expect(screen.getByText('New authority requires attention.')).toBeTruthy();
  });

  it('retains each excluded server action and disables reconnect for an unauthorized viewer', () => {
    render(
      <MCPRecoveryNotice
        task={{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task}
        recovery={recovery({
          mcp_server_name: 'Local tools',
          server_states: [
            {
              mcp_server_id: 'server-stdio',
              name: 'Local tools',
              code: 'transport_not_mediated',
              action: 'review_configuration',
              message: 'This server configuration cannot be mediated by the live MCP gateway.',
            },
          ],
        })}
        client={{ service: vi.fn() } as unknown as AgorClient}
      />
    );

    expect(screen.getByText('Local tools')).toBeTruthy();
    expect(screen.getByText(/Only the task creator or an administrator/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Reconnect MCP for this active task' })
    ).toBeDisabled();
  });
});
