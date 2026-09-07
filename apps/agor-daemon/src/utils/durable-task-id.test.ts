import type { GatewayInboundEventID, MessageID, SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  completionCallbackTaskId,
  gatewayInboundSessionId,
  gatewayInboundTaskId,
  propagatedCompletionCallbackTaskId,
  widgetAutoResumeTaskId,
} from './durable-task-id.js';

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('durable internal Task identities', () => {
  it('derives a stable widget Task identity distinct from the widget Message', () => {
    const widgetId = '019f0000-0000-7000-8000-000000000010' as MessageID;
    const taskId = widgetAutoResumeTaskId(widgetId);
    expect(widgetAutoResumeTaskId(widgetId)).toBe(taskId);
    expect(taskId).not.toBe(widgetId);
    expect(taskId).toMatch(uuidV7);
  });

  it('derives a stable root completion callback per subscription and target', () => {
    const source = '019f0000-0000-7000-8000-000000000001' as TaskID;
    const target = '019f0000-0000-7000-8000-000000000002' as SessionID;
    const subscription = source as import('@agor/core/types').CompletionSubscriptionID;
    expect(propagatedCompletionCallbackTaskId(subscription, target)).toBe(
      propagatedCompletionCallbackTaskId(subscription, target)
    );
    expect(propagatedCompletionCallbackTaskId(subscription, target)).not.toBe(
      completionCallbackTaskId(source, target)
    );
  });

  it('derives a target-specific callback identity from the source Task', () => {
    const source = '019f0000-0000-7000-8000-000000000001' as TaskID;
    const target = '019f0000-0000-7000-8000-000000000002' as SessionID;
    const taskId = completionCallbackTaskId(source, target);
    expect(completionCallbackTaskId(source, target)).toBe(taskId);
    expect(taskId).toMatch(uuidV7);
    expect(
      completionCallbackTaskId(source, '019f0000-0000-7000-8000-000000000003' as SessionID)
    ).not.toBe(taskId);
  });

  it('derives stable, domain-separated gateway Session and Task identities', () => {
    const event = '019f0000-0000-7000-8000-000000000004' as GatewayInboundEventID;
    expect(gatewayInboundTaskId(event)).toMatch(uuidV7);
    expect(gatewayInboundSessionId(event)).toMatch(uuidV7);
    expect(gatewayInboundTaskId(event)).not.toBe(gatewayInboundSessionId(event));
    expect(gatewayInboundTaskId(event)).toBe(gatewayInboundTaskId(event));
  });
});
