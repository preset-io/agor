import type { Message } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { gatewayRouteHook } from './gateway-route';

function contextFor(message: Partial<Message>, routeMessageAfterCommit: ReturnType<typeof vi.fn>) {
  const gateway = {
    routeMessageAfterCommit,
    wasMessageStreamedToSlack: vi.fn(() => false),
    wasTaskStreamedToSlack: vi.fn(() => false),
  };
  return {
    result: {
      message_id: 'message-1',
      session_id: 'session-1',
      role: 'assistant',
      type: 'assistant',
      content: 'final response',
      ...message,
    },
    params: { tenant: { tenant_id: 'tenant-test' } },
    app: { service: vi.fn(() => gateway) },
  } as never;
}

describe('gatewayRouteHook', () => {
  it('passes assistant Message identity to the legacy after-commit route', async () => {
    const routeMessageAfterCommit = vi.fn();
    const context = contextFor({ message_id: 'assistant-1' }, routeMessageAfterCommit);

    await gatewayRouteHook(context);

    expect(routeMessageAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message_id: 'assistant-1', message: 'final response' }),
      context.params
    );
  });

  it('does not echo a gateway-originated user Message', async () => {
    const routeMessageAfterCommit = vi.fn();
    const context = contextFor(
      { role: 'user', type: 'user', metadata: { source: 'gateway' }, content: 'inbound' },
      routeMessageAfterCommit
    );

    await gatewayRouteHook(context);

    expect(routeMessageAfterCommit).not.toHaveBeenCalled();
  });

  it('attributes a shared-session prompt to the Task actor', async () => {
    const routeMessageAfterCommit = vi.fn();
    const context = contextFor(
      {
        role: 'user',
        type: 'user',
        task_id: 'task-b',
        metadata: { source: 'agor' },
        content: 'prompt from Bob',
      },
      routeMessageAfterCommit
    ) as {
      app: { service: ReturnType<typeof vi.fn> };
      params: unknown;
    };
    context.app.service.mockImplementation((path: string) => {
      if (path === 'gateway') {
        return {
          routeMessageAfterCommit,
          wasMessageStreamedToSlack: vi.fn(() => false),
          wasTaskStreamedToSlack: vi.fn(() => false),
        };
      }
      if (path === 'tasks') {
        return { get: vi.fn(async () => ({ session_id: 'session-1', created_by: 'bob' })) };
      }
      if (path === 'users') return { get: vi.fn(async () => ({ name: 'Bob' })) };
      throw new Error(`Unexpected service: ${path}`);
    });

    await gatewayRouteHook(context as never);

    expect(routeMessageAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[Bob]: prompt from Bob' }),
      context.params
    );
  });

  it('uses neutral attribution when a legacy Task actor cannot be resolved', async () => {
    const routeMessageAfterCommit = vi.fn();
    const context = contextFor(
      {
        role: 'user',
        type: 'user',
        task_id: 'legacy-task',
        metadata: { source: 'agor' },
        content: 'legacy prompt',
      },
      routeMessageAfterCommit
    ) as { app: { service: ReturnType<typeof vi.fn> }; params: unknown };
    context.app.service.mockImplementation((path: string) => {
      if (path === 'gateway') {
        return {
          routeMessageAfterCommit,
          wasMessageStreamedToSlack: vi.fn(() => false),
          wasTaskStreamedToSlack: vi.fn(() => false),
        };
      }
      if (path === 'tasks') return { get: vi.fn(async () => null) };
      if (path === 'users') return { get: vi.fn() };
      throw new Error(`Unexpected service: ${path}`);
    });

    await gatewayRouteHook(context as never);

    expect(routeMessageAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[Agor user]: legacy prompt' }),
      context.params
    );
  });
});
