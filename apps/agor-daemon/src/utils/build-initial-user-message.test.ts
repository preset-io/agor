import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { buildInitialUserMessage } from './build-initial-user-message';

describe('buildInitialUserMessage attachments', () => {
  it('persists the exact prompt text with image blocks linked to the task retrieval route', () => {
    const sessionId = '018f0000-0000-7000-8000-000000000001' as SessionID;
    const taskId = '018f0000-0000-7000-8000-000000000002' as TaskID;
    const prompt = 'Attached files:\n- /tmp/chart.png\n\nCompare this chart';

    const message = buildInitialUserMessage({
      sessionId,
      taskId,
      index: 0,
      timestamp: '2026-07-21T12:00:00.000Z',
      content: prompt,
      attachments: [
        {
          filename: 'chart.png',
          path: '/tmp/chart.png',
          mime_type: 'image/png',
        },
      ],
    });

    expect(message.content).toEqual([
      { type: 'text', text: prompt },
      {
        type: 'image',
        filename: 'chart.png',
        media_type: 'image/png',
        url: `/sessions/${sessionId}/tasks/${taskId}/images/0`,
      },
    ]);
    expect(message.content_preview).toBe(prompt);
  });
});
