import { Forbidden } from '@agor/core/feathers';
import type { HookContext, Message, MessageID } from '@agor/core/types';

export type WidgetMessageLoader = (messageId: MessageID) => Promise<Message | null>;

const TERMINAL_WIDGET_STATUSES = new Set(['submitted', 'dismissed', 'already_present']);

function declaresWidgetMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  const metadata = record.metadata;
  return (
    record.type === 'widget_request' ||
    (!!metadata && typeof metadata === 'object' && !Array.isArray(metadata) && 'widget' in metadata)
  );
}

/** Reject public single/bulk DTOs that attempt to mint daemon-owned widgets. */
export function assertExternalWidgetMessageCreateAllowed(data: unknown): void {
  const writes = Array.isArray(data) ? data : [data];
  if (writes.some(declaresWidgetMessage)) {
    throw new Forbidden('Widget messages can only be created by the daemon');
  }
}

/**
 * Keep widget creation and lifecycle state behind daemon-owned routes.
 *
 * The durable resolution token only fences cooperating writers. External
 * generic Message CRUD must not be able to mint a widget, replace/patch its
 * metadata, or remove an in-flight claim and thereby reopen its external
 * effect. Internal calls remain available for trusted daemon projections.
 */
export function protectExternalWidgetMessageWrites(loadMessage: WidgetMessageLoader) {
  return async (context: HookContext): Promise<HookContext> => {
    if (!context.params.provider) return context;

    if (context.method === 'create') {
      assertExternalWidgetMessageCreateAllowed(context.data);
      return context;
    }

    // Complete replacement is not part of the public Message contract. Apart
    // from lacking a safe field allowlist, it could erase a widget claim in
    // one write. The transport method is also omitted at registration.
    if (context.method === 'update') {
      throw new Forbidden('Message replacement is not available to external callers');
    }

    if (context.method !== 'patch' && context.method !== 'remove') return context;
    if (context.id === null || context.id === undefined) {
      throw new Forbidden('Bulk external message mutation is not supported');
    }
    if (context.method === 'patch' && declaresWidgetMessage(context.data)) {
      throw new Forbidden('Widget lifecycle metadata is daemon-owned');
    }
    const message = await loadMessage(String(context.id) as MessageID);
    const widget = message?.metadata?.widget;
    const isWidget = message?.type === 'widget_request' || widget !== undefined;
    if (!isWidget) return context;

    if (context.method === 'patch') {
      throw new Forbidden('Widget messages can only be changed through widget resolution routes');
    }

    if (!widget || !TERMINAL_WIDGET_STATUSES.has(widget.status)) {
      throw new Forbidden('Pending or resolving widget messages cannot be removed externally');
    }
    return context;
  };
}
