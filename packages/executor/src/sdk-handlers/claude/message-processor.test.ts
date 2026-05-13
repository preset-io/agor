import type { SessionID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { type ProcessedEvent, SDKMessageProcessor } from './message-processor.js';

function createProcessor() {
  return new SDKMessageProcessor({
    sessionId: 'test-session-id' as SessionID,
  });
}

function rateLimitMsg(info: Record<string, unknown>) {
  return { type: 'rate_limit_event', rate_limit_info: info } as never;
}

function systemMsg(payload: Record<string, unknown>) {
  return { type: 'system', ...payload } as never;
}

describe('SDKMessageProcessor system event suppression', () => {
  it('suppresses status=requesting (PR #1116)', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({ subtype: 'status', status: 'requesting', session_id: 's', uuid: 'u' })
    );
    expect(events.filter((e) => e.type === 'sdk_event')).toHaveLength(0);
  });

  it('suppresses task_updated, including patches with an error field', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({
        subtype: 'task_updated',
        task_id: 't1',
        patch: { status: 'failed', error: 'boom' },
        session_id: 's',
        uuid: 'u',
      })
    );
    expect(events.filter((e) => e.type === 'sdk_event')).toHaveLength(0);
  });

  it('surfaces user-meaningful system subtypes (e.g. mirror_error)', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      systemMsg({
        subtype: 'mirror_error',
        error: 'disk full',
        key: { projectKey: 'p', sessionId: 's' },
        session_id: 's',
        uuid: 'u',
      })
    );
    const sdkEvents = events.filter((e) => e.type === 'sdk_event');
    expect(sdkEvents).toHaveLength(1);
    const event = sdkEvents[0] as Extract<ProcessedEvent, { type: 'sdk_event' }>;
    expect(event.sdkType).toBe('system');
    expect(event.sdkSubtype).toBe('mirror_error');
  });
});

describe('SDKMessageProcessor rate_limit_event handling', () => {
  it('suppresses allowed status with no overage concern', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({ status: 'allowed', rateLimitType: 'five_hour' })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });

  it('suppresses allowed status even when overageStatus is rejected', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'allowed',
        overageStatus: 'rejected',
        rateLimitType: 'five_hour',
      })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });

  it('suppresses allowed status even when overageStatus is allowed_warning', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'allowed',
        overageStatus: 'allowed_warning',
        rateLimitType: 'five_hour',
      })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });

  it('surfaces rejected status', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: 1700000000,
      })
    );
    const rateLimitEvents = events.filter((e) => e.type === 'rate_limit');
    expect(rateLimitEvents).toHaveLength(1);
    const event = rateLimitEvents[0] as Extract<ProcessedEvent, { type: 'rate_limit' }>;
    expect(event.status).toBe('rejected');
    expect(event.rateLimitType).toBe('five_hour');
    expect(event.resetsAt).toBe(1700000000);
  });

  it('surfaces allowed_warning status', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({
        status: 'allowed_warning',
        rateLimitType: 'daily',
        resetsAt: 1700000000,
      })
    );
    const rateLimitEvents = events.filter((e) => e.type === 'rate_limit');
    expect(rateLimitEvents).toHaveLength(1);
    const event = rateLimitEvents[0] as Extract<ProcessedEvent, { type: 'rate_limit' }>;
    expect(event.status).toBe('allowed_warning');
  });

  it('suppresses unknown/future status values', async () => {
    const processor = createProcessor();
    const events = await processor.process(
      rateLimitMsg({ status: 'some_future_status', rateLimitType: 'five_hour' })
    );
    expect(events.filter((e) => e.type === 'rate_limit')).toHaveLength(0);
  });
});
