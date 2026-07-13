import type { Link, Message } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { makeTestLink } from '../Links/testUtils';
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

const makeLink = (patch: Partial<Link> = {}) =>
  makeTestLink({
    source_message_id: 'message-1' as Link['source_message_id'],
    kind: 'document',
    source: 'upload',
    url: null,
    file_path: '/home/agor/.agor/uploads/session/spec.pdf',
    title: 'spec.pdf',
    mime_type: 'application/pdf',
    ...patch,
  });

function renderMessage(patch: Partial<Message>, attachmentLinks?: Link[]) {
  return render(
    <MemoryRouter>
      <MessageBlock message={makeMessage(patch)} attachmentLinks={attachmentLinks} />
    </MemoryRouter>
  );
}

describe('MessageBlock attachments', () => {
  it('renders a user attachment-only message with blank content', () => {
    renderMessage({ content: '   ' }, [makeLink()]);

    expect(screen.getByRole('button', { name: /download spec\.pdf/i })).toBeInTheDocument();
  });

  it('renders parsed knowledge references as cards in assistant messages', () => {
    renderMessage(
      {
        role: 'assistant',
        type: 'assistant',
        content: 'See kb://orgs/preset/pr-review',
      },
      [
        makeLink({
          kind: 'kb_ref',
          source: 'parsed',
          file_path: null,
          target_key: 'ref:agor://kb/orgs/preset/pr-review',
          title: null,
          mime_type: null,
          ref_uri: 'agor://kb/orgs/preset/pr-review',
        }),
      ]
    );

    expect(
      screen.getByRole('button', { name: 'Open KB: orgs/preset/pr-review' })
    ).toBeInTheDocument();
  });

  it('renders a knowledge card immediately for a compact reference without a persisted link', () => {
    renderMessage({
      role: 'assistant',
      type: 'assistant',
      content: 'See kb://orgs/preset/pr-review',
    });

    expect(
      screen.getByRole('button', { name: 'Open KB: orgs/preset/pr-review' })
    ).toBeInTheDocument();
  });

  it('hides full paths from default upload notifications when attachment cards render', () => {
    renderMessage(
      {
        content:
          'Uploaded files: /home/agor/.agor/uploads/session/spec.pdf, /home/agor/.agor/uploads/session/chart.png',
      },
      [
        makeLink(),
        makeLink({
          link_id: 'link-2' as Link['link_id'],
          kind: 'image',
          title: 'chart.png',
          file_path: '/home/agor/.agor/uploads/session/chart.png',
          target_key: 'file:/home/agor/.agor/uploads/session/chart.png',
          mime_type: 'image/png',
        }),
      ]
    );

    expect(screen.getByRole('button', { name: /download spec\.pdf/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /open image preview for chart\.png/i })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/spec.pdf');
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/chart.png');
    expect(document.body.textContent).not.toContain('Uploaded files');
    expect(document.body.textContent).not.toContain('This session · Upload');
  });

  it('hides the composer attachment heading and list markers when cards render', () => {
    renderMessage({ content: 'Attached files:\n- .agor/uploads/session/chart.png' }, [
      makeLink({
        kind: 'image',
        title: 'chart.png',
        file_path: '.agor/uploads/session/chart.png',
        target_key: 'file:.agor/uploads/session/chart.png',
        mime_type: 'image/png',
      }),
    ]);

    expect(
      screen.getByRole('button', { name: /open image preview for chart\.png/i })
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Attached files');
    expect(document.body.textContent).not.toMatch(/(^|\s)-($|\s)/);
  });

  it('keeps custom upload prefixes but hides attachment path lists', () => {
    renderMessage(
      {
        content:
          'QA upload set: /home/agor/.agor/uploads/session/a.png, /home/agor/.agor/uploads/session/b.md',
      },
      [
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
      ]
    );

    expect(screen.getByText('QA upload set:')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/a.png');
    expect(document.body.textContent).not.toContain('/home/agor/.agor/uploads/session/b.md');
  });

  it('leaves normal user messages without attachments unchanged', () => {
    renderMessage({ content: 'Please inspect /home/agor/.agor/uploads/session/spec.pdf' });

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
    const { container } = renderMessage({ content: '   ' });

    expect(container).toBeEmptyDOMElement();
  });
});
