import type { Link, Message } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { MessageBlock, stripAttachmentFilePaths } from './MessageBlock';

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

  it('renders parsed knowledge references as cards in assistant messages', () => {
    render(
      <MemoryRouter>
        <MessageBlock
          message={makeMessage({
            role: 'assistant',
            type: 'assistant',
            content: 'See kb://orgs/preset/pr-review',
          })}
          attachmentLinks={[
            makeLink({
              kind: 'kb_ref',
              source: 'parsed',
              file_path: null,
              target_key: 'ref:agor://kb/orgs/preset/pr-review',
              title: null,
              mime_type: null,
              ref_uri: 'agor://kb/orgs/preset/pr-review',
            }),
          ]}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('button', { name: 'Open KB: orgs/preset/pr-review' })
    ).toBeInTheDocument();
  });

  it('renders a knowledge card immediately for a compact reference without a persisted link', () => {
    render(
      <MemoryRouter>
        <MessageBlock
          message={makeMessage({
            role: 'assistant',
            type: 'assistant',
            content: 'See kb://orgs/preset/pr-review',
          })}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('button', { name: 'Open KB: orgs/preset/pr-review' })
    ).toBeInTheDocument();
  });

  it('hides full paths from default upload notifications when attachment cards render', () => {
    render(
      <MemoryRouter>
        <MessageBlock
          message={makeMessage({
            content:
              'Uploaded files: /home/agor/.agor/uploads/session/spec.pdf, /home/agor/.agor/uploads/session/chart.png',
          })}
          attachmentLinks={[
            makeLink(),
            makeLink({
              link_id: 'link-2' as Link['link_id'],
              kind: 'image',
              title: 'chart.png',
              file_path: '/home/agor/.agor/uploads/session/chart.png',
              target_key: 'file:/home/agor/.agor/uploads/session/chart.png',
              mime_type: 'image/png',
            }),
          ]}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('button', { name: /open spec\.pdf/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open image preview for chart\.png/i })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/spec.pdf');
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/chart.png');
    expect(document.body.textContent).not.toContain('Uploaded files');
    expect(document.body.textContent).not.toContain('This session · Upload');
  });

  it('hides the composer attachment heading and list markers when cards render', () => {
    render(
      <MemoryRouter>
        <MessageBlock
          message={makeMessage({
            content: 'Attached files:\n- .agor/uploads/session/chart.png',
          })}
          attachmentLinks={[
            makeLink({
              kind: 'image',
              title: 'chart.png',
              file_path: '.agor/uploads/session/chart.png',
              target_key: 'file:.agor/uploads/session/chart.png',
              mime_type: 'image/png',
            }),
          ]}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('button', { name: /open image preview for chart\.png/i })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Attached files');
    expect(document.body.textContent).not.toMatch(/(^|\s)-($|\s)/);
  });

  it('keeps custom upload prefixes but hides attachment path lists', () => {
    render(
      <MemoryRouter>
        <MessageBlock
          message={makeMessage({
            content:
              'QA upload set: /home/agor/.agor/uploads/session/a.png, /home/agor/.agor/uploads/session/b.md',
          })}
          attachmentLinks={[
            makeLink({
              title: 'a.png',
              kind: 'image',
              file_path: '/home/agor/.agor/uploads/session/a.png',
              target_key: 'file:/home/agor/.agor/uploads/session/a.png',
              mime_type: 'image/png',
            }),
            makeLink({
              link_id: 'link-2' as Link['link_id'],
              title: 'b.md',
              file_path: '/home/agor/.agor/uploads/session/b.md',
              target_key: 'file:/home/agor/.agor/uploads/session/b.md',
              mime_type: 'text/markdown',
            }),
          ]}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('QA upload set:')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/a.png');
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/b.md');
  });

  it('leaves normal user messages without attachments unchanged', () => {
    render(
      <MemoryRouter>
        <MessageBlock
          message={makeMessage({
            content: 'Please inspect /home/agor/.agor/uploads/session/spec.pdf',
          })}
        />
      </MemoryRouter>
    );

    expect(document.body.textContent).toContain(
      'Please inspect /home/agor/.agor/uploads/session/spec.pdf'
    );
  });

  it('redacts absolute prompt paths for relative upload rows without reformatting the message', () => {
    const content = [
      'Uploaded: /home/agor/.agor/uploads/019-file.pdf',
      '',
      '  const value  =  1;',
      'Notes: keep, deliberate, spacing',
    ].join('\n');

    expect(
      stripAttachmentFilePaths(content, [
        makeLink({ file_path: '019-file.pdf', target_key: 'file:019-file.pdf' }),
      ])
    ).toBe(
      ['Uploaded:', '', '  const value  =  1;', 'Notes: keep, deliberate, spacing'].join('\n')
    );
  });

  it('does not redact a relative upload filename mentioned as normal prose', () => {
    expect(
      stripAttachmentFilePaths('Please review 019-file.pdf carefully.', [
        makeLink({ file_path: '019-file.pdf', target_key: 'file:019-file.pdf' }),
      ])
    ).toBe('Please review 019-file.pdf carefully.');
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
