import { PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND } from '@agor/core/types';
import type { Message } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';

describe('MessageBlock layout', () => {
  it('lets a user bubble shrink around intrinsically wide markdown', () => {
    const message = {
      message_id: 'message-1',
      session_id: 'session-1',
      type: 'message',
      role: 'user',
      index: 0,
      timestamp: '2026-07-23T00:00:00.000Z',
      content: '```json\n{"path":"/an/intrinsically/very/wide/path"}\n```',
      content_preview: 'wide code',
    } as unknown as Message;

    const { container } = render(<MessageBlock message={message} />);
    const bubble = container.querySelector<HTMLElement>('.ant-bubble');
    const body = container.querySelector<HTMLElement>('.ant-bubble-body');

    expect(bubble).toHaveStyle({ maxWidth: '100%' });
    expect(body).toHaveStyle({ minWidth: '0' });
  });

  it('renders provider credit exhaustion as recovery state instead of raw provider text', () => {
    const unsafeProviderBody = 'Credit balance is too low; provider-secret-body-marker';
    const message = {
      message_id: 'message-2',
      session_id: 'session-1',
      type: 'system',
      role: 'system',
      index: 1,
      timestamp: '2026-07-23T00:00:00.000Z',
      content: unsafeProviderBody,
      content_preview: unsafeProviderBody,
      metadata: {
        error_kind: PROVIDER_CREDIT_EXHAUSTED_ERROR_KIND,
        error_code: 'PROVIDER_CREDIT_EXHAUSTED',
        tool: 'claude-code',
      },
    } as unknown as Message;

    render(<MessageBlock message={message} />);

    expect(screen.getByText(/no available balance or usage quota/i)).toBeInTheDocument();
    expect(screen.queryByText(/provider-secret-body-marker/i)).not.toBeInTheDocument();
  });
});
