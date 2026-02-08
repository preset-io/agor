/**
 * Gateway Route Hook
 *
 * FeathersJS `after` hook for the messages service `create` method.
 * Routes assistant messages to connected platforms via the gateway service.
 * Fire-and-forget — never blocks message creation.
 */

import type { HookContext, Message } from '@agor/core/types';
import type { GatewayService } from '../services/gateway';

/**
 * After hook that routes assistant messages through the gateway.
 * Only fires for assistant messages. Errors are caught and logged,
 * never propagated to avoid slowing down message creation.
 */
export const gatewayRouteHook = async (context: HookContext) => {
  const message = context.result as Message;

  // Only route assistant messages
  if (message.role !== 'assistant') {
    return context;
  }

  // Fire-and-forget: route message through gateway
  try {
    const gatewayService = context.app.service('gateway') as unknown as GatewayService;

    const messageText =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

    // Don't await — fire and forget
    gatewayService
      .routeMessage({
        session_id: message.session_id,
        message: messageText,
      })
      .catch((error: unknown) => {
        console.warn('[gateway-route] Failed to route message:', error);
      });
  } catch (error) {
    console.warn('[gateway-route] Failed to invoke gateway service:', error);
  }

  return context;
};
