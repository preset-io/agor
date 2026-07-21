import type { Message } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';
import { MessageBlock } from './MessageBlock';

function imageMessage(): Message {
  return {
    message_id: 'message-1',
    session_id: 'session-1',
    task_id: 'task-1',
    type: 'user',
    role: 'user',
    index: 0,
    timestamp: '2026-07-21T12:00:00.000Z',
    content_preview: 'Compare this chart',
    content: [
      {
        type: 'text',
        text: 'Attached files:\n- /uploads/chart.png\n\nCompare this chart',
      },
      {
        type: 'image',
        filename: 'chart.png',
        media_type: 'image/png',
        url: '/sessions/session-1/tasks/task-1/images/0',
      },
    ],
  } as Message;
}

describe('MessageBlock image previews', () => {
  beforeEach(() => {
    localStorage.setItem(ACCESS_TOKEN_KEY, 'browser-token');
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:authenticated-image'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('fetches image bytes with bearer auth, renders an Ant Design preview, and revokes the blob URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(['png'], { type: 'image/png' }), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(
      <App>
        <MessageBlock message={imageMessage()} currentUserId="user-1" />
      </App>
    );

    const thumbnail = await screen.findByRole('img', { name: 'chart.png' });
    expect(thumbnail).toHaveAttribute('src', 'blob:authenticated-image');
    expect(screen.getByText('Compare this chart')).toBeInTheDocument();
    expect(screen.queryByText('Attached files:')).not.toBeInTheDocument();
    expect(screen.queryByText('/uploads/chart.png')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/sessions/session-1/tasks/task-1/images/0'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer browser-token' },
      })
    );

    fireEvent.click(thumbnail);
    expect(await screen.findByRole('dialog', { name: 'chart.png' })).toBeInTheDocument();

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:authenticated-image');
  });

  it('shows a small fallback when the image cannot be retrieved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));

    render(
      <App>
        <MessageBlock message={imageMessage()} currentUserId="user-1" />
      </App>
    );

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    expect(screen.getByText('Compare this chart')).toBeInTheDocument();
  });

  it('revokes invalid image bytes and shows the fallback when decoding fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new Blob(['invalid']), { status: 200 }))
    );

    render(
      <App>
        <MessageBlock message={imageMessage()} currentUserId="user-1" />
      </App>
    );

    fireEvent.error(await screen.findByRole('img', { name: 'chart.png' }));

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:authenticated-image');
  });
});
