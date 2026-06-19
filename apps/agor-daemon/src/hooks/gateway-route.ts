/**
 * Gateway Route Hook
 *
 * FeathersJS `after` hook for the messages service `create` method.
 * Routes assistant messages to connected platforms via the gateway service.
 * Fire-and-forget — never blocks message creation.
 */

import type { ContentBlock, HookContext, Message } from '@agor/core/types';
import type { GatewayService } from '../services/gateway';

interface GatewayToolUse {
  name: string;
  input: Record<string, unknown>;
}

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

function extractLatestToolUse(content: Message['content']): GatewayToolUse | null {
  if (!Array.isArray(content)) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as Record<string, unknown>;
    if (block.type !== 'tool_use') continue;
    if (typeof block.name !== 'string') continue;
    const input =
      block.input && typeof block.input === 'object' && !Array.isArray(block.input)
        ? (block.input as Record<string, unknown>)
        : {};
    return { name: block.name, input };
  }

  return null;
}

/**
 * After hook that routes messages through the gateway.
 * Routes:
 * - All assistant messages
 * - User messages that originated from Agor UI (not from gateway)
 *
 * Errors are caught and logged, never propagated to avoid slowing down message creation.
 */
export const gatewayRouteHook = async (context: HookContext) => {
  const message = context.result as Message;
  const gatewayService = context.app.service('gateway') as unknown as GatewayService;

  // Determine if message should be routed to gateway
  let shouldRoute = false;
  let messageText = extractText(message.content);
  const latestToolUse = extractLatestToolUse(message.content);

  // Tool-only rows should not be posted as normal chat messages, but they are
  // valuable for the mutable Slack status row: current tool + TodoWrite plan.
  if (!messageText && latestToolUse) {
    try {
      void gatewayService.updateProgress({
        session_id: message.session_id,
        state: 'working',
        task_id: message.task_id,
        tool_name: latestToolUse.name,
        tool_input: latestToolUse.input,
      });
    } catch (error) {
      console.warn('[gateway-route] Failed to route tool progress:', error);
    }
    return context;
  }

  if (!messageText && message.role === 'assistant' && typeof message.content_preview === 'string') {
    messageText = message.content_preview;
  }

  if (message.role === 'assistant') {
    // Always route assistant messages
    shouldRoute = true;
  } else if (message.role === 'user') {
    // Route user messages that originated from Agor (not from gateway)
    const source = message.metadata?.source;

    if (source === 'agor') {
      // User message from Agor UI - route to Slack with username prefix
      shouldRoute = true;

      // Fetch session and user info to prefix with username
      try {
        const sessionsService = context.app.service('sessions');
        const usersService = context.app.service('users');

        const session = await sessionsService.get(message.session_id);
        const user = await usersService.get(session.created_by);

        // Format as "[username]: message"
        messageText = `[${user.name}]: ${messageText}`;
      } catch (error) {
        console.warn('[gateway-route] Failed to fetch user info for message prefix:', error);
        // Continue without prefix if lookup fails
      }
    } else if (source === 'gateway') {
      // User message from gateway (Slack) - don't route (prevents echo)
      shouldRoute = false;
    } else {
      // Legacy message without source tracking - treat as gateway to be safe
      shouldRoute = false;
    }
  }

  if (!shouldRoute) {
    return context;
  }

  if (!messageText) {
    return context; // No text to route (tool-only messages, etc.)
  }

  // Fire-and-forget: route message through gateway
  try {
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
