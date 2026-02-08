/**
 * Gateway Route Hook
 *
 * FeathersJS `after` hook for the messages service `create` method.
 * Routes assistant messages to connected platforms via the gateway service.
 * Fire-and-forget — never blocks message creation.
 */

import type { ContentBlock, HookContext, Message } from '@agor/core/types';
import type { GatewayService } from '../services/gateway';

/**
 * Extract readable text from message content.
 * Handles string content, ContentBlock[] arrays, and other shapes gracefully.
 */
function extractText(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b) => b.type === 'text')
      .map((b) => (b as Record<string, unknown>).text as string)
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * After hook that routes assistant messages through the gateway.
 * Only fires for assistant messages with text content. Errors are caught
 * and logged, never propagated to avoid slowing down message creation.
 */
export const gatewayRouteHook = async (context: HookContext) => {
  const message = context.result as Message;

  // Only route assistant messages
  if (message.role !== 'assistant') {
    return context;
  }

  const messageText = extractText(message.content);
  if (!messageText) {
    return context; // No text to route (tool-only messages, etc.)
  }

  // Fire-and-forget: route message through gateway
  try {
    const gatewayService = context.app.service('gateway') as unknown as GatewayService;

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
