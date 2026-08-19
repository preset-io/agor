import type { GatewayHistoryCapability } from '@agor/core/gateway';
import { describe, expect, it, vi } from 'vitest';

import {
  coordinateGatewayCatchUp,
  formatGatewayCatchUpPrompt,
  GATEWAY_CATCH_UP_MESSAGE_LIMIT,
} from './gateway-catch-up.js';

describe('gateway catch-up', () => {
  it('can begin a newly adopted thread without reading older ambient history', async () => {
    const fetchConversationHistory = vi.fn();
    const result = await coordinateGatewayCatchUp({
      history: {
        fetchConversationHistory,
        compareCursors: (left, right) => Number(left) - Number(right ?? 0),
      },
      threadId: 'discord:123',
      throughCursor: '123',
      triggerCursor: '123',
      created: true,
      includeHistory: false,
      render: {
        providerLabel: 'Discord',
        threadId: 'discord:123',
        currentText: 'current summon',
        contextLines: ['- Thread: `discord:123`'],
        historyToolLabel: 'Discord thread history tool',
      },
    });

    expect(fetchConversationHistory).not.toHaveBeenCalled();
    expect(result.nextCursor).toBe('123');
    expect(result.prompt).toContain('current summon');
    expect(result.prompt).not.toContain('Previous thread messages');
  });

  it('renders provider-neutral history with explicit untrusted and truncation language', () => {
    const prompt = formatGatewayCatchUpPrompt({
      providerLabel: 'Discord',
      threadId: 'discord:123',
      currentText: 'please answer',
      currentSenderLabel: 'Alice',
      currentTime: '2026-08-18T08:00:00.000Z',
      contextLines: ['- Thread: `discord:123`'],
      messages: [
        {
          cursor: '1',
          iso_time: '2026-08-18T07:59:00.000Z',
          actor_label: 'Bob',
          text: 'ambient message',
          is_trigger: false,
        },
        {
          cursor: '2',
          iso_time: '2026-08-18T08:00:00.000Z',
          actor_label: 'Alice',
          text: 'please answer',
          is_trigger: true,
        },
      ],
      hasMore: true,
      reason: 'missed_since_last_mention',
      historyToolLabel: 'Discord thread history tool',
    });

    expect(prompt).toContain('**Discord context**');
    expect(prompt).toContain('untrusted user-provided context');
    expect(prompt).toContain('ambient message');
    expect(prompt).not.toContain('- **Alice** · 2026-08-18 08:00:00 UTC: please answer\n-');
    expect(prompt).toContain('Discord thread context was truncated');
    expect(prompt).toContain('### Current summon');
  });

  it('uses the shared 200-message request and provider cursor ordering', async () => {
    const fetchConversationHistory = vi.fn(async () => ({
      has_more: false,
      messages: [
        {
          cursor: '101.0',
          iso_time: '2026-08-18T08:00:01.000Z',
          actor_label: 'Seen',
          text: 'old',
          is_trigger: false,
        },
        {
          cursor: '102.0',
          iso_time: '2026-08-18T08:00:02.000Z',
          actor_label: 'New',
          text: 'include me',
          is_trigger: false,
        },
      ],
    }));
    const history: GatewayHistoryCapability = {
      fetchConversationHistory,
      compareCursors: (left, right) => Number(left) - Number(right),
    };

    const result = await coordinateGatewayCatchUp({
      history,
      threadId: 'provider:thread',
      afterCursor: '101.0',
      throughCursor: '103.0',
      triggerCursor: '103.0',
      created: false,
      render: {
        providerLabel: 'Provider',
        threadId: 'provider:thread',
        currentText: 'summon',
        contextLines: ['- Thread: `provider:thread`'],
        historyToolLabel: 'thread history tool',
      },
    });

    expect(fetchConversationHistory).toHaveBeenCalledWith({
      threadId: 'provider:thread',
      afterCursor: '101.0',
      throughCursor: '103.0',
      triggerCursor: '103.0',
      limit: GATEWAY_CATCH_UP_MESSAGE_LIMIT,
      includeBotMessages: false,
      allowTruncatedLowerBound: true,
      preferLatest: true,
    });
    expect(result.prompt).toContain('include me');
    expect(result.prompt).not.toContain('old');
    expect(result.nextCursor).toBe('103.0');
  });
});
