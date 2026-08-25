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
});
