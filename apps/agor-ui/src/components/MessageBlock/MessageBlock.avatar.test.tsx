import type { Message } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IDENTITY_AVATAR_SIZE } from '../../constants/ui';
import { MessageBlock } from './MessageBlock';

const messageOf = (role: 'user' | 'assistant'): Message =>
  ({
    message_id: `message-${role}`,
    session_id: 'session-1',
    type: 'message',
    role,
    index: 0,
    timestamp: '2026-07-23T00:00:00.000Z',
    content: 'hello there',
    content_preview: 'hello there',
  }) as unknown as Message;

const renderAvatar = (role: 'user' | 'assistant') => {
  const { container } = render(<MessageBlock message={messageOf(role)} />);
  const avatar = container.querySelector<HTMLElement>('.ant-bubble-avatar .ant-avatar');
  if (!avatar) throw new Error(`no avatar rendered for ${role}`);
  return avatar;
};

describe('MessageBlock avatar sizing', () => {
  it.each([
    ['user', 'user'],
    ['agent', 'assistant'],
  ] as const)('renders the %s avatar at the shared identity size', (_label, role) => {
    expect(renderAvatar(role)).toHaveStyle({
      width: `${IDENTITY_AVATAR_SIZE}px`,
      height: `${IDENTITY_AVATAR_SIZE}px`,
    });
  });

  it('keeps a visible, named AntD timestamp control in the grouped-message gutter', () => {
    const { container } = render(
      <MessageBlock message={{ ...messageOf('assistant'), index: 7 }} showAvatar={false} />
    );
    const timestamp = screen.getByRole('button', {
      name: /Message 7 timestamp:.*Message index: 7/s,
    });
    expect(timestamp).toHaveClass('ant-btn');
    expect(timestamp.querySelector('.anticon-clock-circle')).not.toBeNull();
    expect(timestamp.closest('.ant-bubble-avatar')).not.toBeNull();
    expect(timestamp).toHaveStyle({
      width: `${IDENTITY_AVATAR_SIZE}px`,
      height: `${IDENTITY_AVATAR_SIZE}px`,
    });
    expect(container.querySelector('[data-testid="avatar-spacer"]')).toBeNull();
  });
});
