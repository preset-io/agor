import type { Link, Message } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MessageBlock } from './MessageBlock';

const now = '2026-07-06T00:00:00.000Z';

function makeMessage(patch: Partial<Message> = {}): Message {
  return {
    message_id: 'message-1' as Message['message_id'],
    session_id: 'session-1' as Message['session_id'],
    task_id: 'task-1' as Message['task_id'],
    type: 'user',
    role: 'user',
    index: 0,
    timestamp: now,
    content_preview: '',
    content: '',
    metadata: null,
    ...patch,
  } as Message;
}

function makeLink(patch: Partial<Link> = {}): Link {
  return {
    link_id: 'link-1' as Link['link_id'],
    branch_id: null,
    session_id: 'session-1' as Link['session_id'],
    source_message_id: 'message-1' as Link['source_message_id'],
    kind: 'document',
    source: 'upload',
    url: null,
    ref_uri: null,
    file_path: '/home/agor/.agor/uploads/session/spec.pdf',
    target_key: 'file:/home/agor/.agor/uploads/session/spec.pdf',
    is_pinned: false,
    title: 'spec.pdf',
    mime_type: 'application/pdf',
    metadata: null,
    created_by: null,
    created_at: now,
    updated_at: now,
    ...patch,
  } as Link;
}

describe('MessageBlock attachments', () => {
  it('renders a user attachment-only message with blank content', () => {
    render(
      <MemoryRouter>
        <MessageBlock message={makeMessage({ content: '   ' })} attachmentLinks={[makeLink()]} />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /open spec\.pdf/i })).toBeInTheDocument();
  });

  it('keeps blank messages without attachments hidden', () => {
    const { container } = render(
      <MemoryRouter>
        <MessageBlock message={makeMessage({ content: '   ' })} />
      </MemoryRouter>
    );

    expect(container).toBeEmptyDOMElement();
  });
});
