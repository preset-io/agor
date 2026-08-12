import type { Message } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('renders provider billing recovery instead of raw zero-turn text', () => {
    const onOpenSettings = vi.fn();
    const message = {
      message_id: 'message-2',
      session_id: 'session-1',
      type: 'system',
      role: 'system',
      index: 1,
      timestamp: '2026-07-23T00:00:00.000Z',
      content: 'Credit balance is too low',
      content_preview: 'Credit balance is too low',
      metadata: {
        error_kind: 'provider_credit_exhausted',
        tool: 'claude-code',
      },
    } as unknown as Message;

    render(<MessageBlock message={message} onOpenAgenticToolSettings={onOpenSettings} />);

    expect(screen.getByText(/needs available credit or quota/i)).toBeVisible();
    expect(screen.getByText(/workspace and teammate are still set up/i)).toBeVisible();
    expect(screen.getByRole('link', { name: /Open Claude Code's console/i })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Open Claude Code settings/i }));
    expect(onOpenSettings).toHaveBeenCalledWith('claude-code');
    expect(screen.queryByText(/credit balance is too low/i)).not.toBeInTheDocument();
  });
});
