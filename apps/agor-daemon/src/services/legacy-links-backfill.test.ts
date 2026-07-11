import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LinksRepository, MessagesRepository } from '@agor/core/db';
import { type Message, MessageRole, type UUID } from '@agor/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  seedLinkBranch,
  seedLinkSession,
} from '../../../../packages/core/src/db/repositories/links.test-helpers';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { backfillLegacySessionLinks, extractLegacyAttachmentPaths } from './legacy-links-backfill';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('legacy links backfill', () => {
  it('extracts only bullet items immediately below the legacy heading', () => {
    const message = {
      content:
        'Attached files:\n- /home/me/.agor/uploads/a.png\n- "/home/me/.agor/uploads/b.md"\n\nDo this',
    } as Pick<Message, 'content'>;
    expect(extractLegacyAttachmentPaths(message)).toEqual([
      '/home/me/.agor/uploads/a.png',
      '/home/me/.agor/uploads/b.md',
    ]);
  });

  it('extracts paths from the legacy advanced-upload notification', () => {
    const message = {
      content:
        'Note: the user uploaded file(s): /home/me/.agor/uploads/a.png, /home/me/.agor/uploads/b.md\n\nPlease review them.',
    } as Pick<Message, 'content'>;

    expect(extractLegacyAttachmentPaths(message)).toEqual([
      '/home/me/.agor/uploads/a.png',
      '/home/me/.agor/uploads/b.md',
    ]);
  });

  dbTest(
    'backfills existing URLs, Knowledge refs, and safe uploaded files idempotently',
    async ({ db }) => {
      const branch = await seedLinkBranch(db);
      const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
      const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-legacy-links-'));
      tempRoots.push(uploadRoot);
      await fs.writeFile(path.join(uploadRoot, 'historic.png'), 'png bytes');
      const message: Message = {
        message_id: generateId(),
        session_id: session.session_id,
        type: 'user',
        role: MessageRole.USER,
        index: 0,
        timestamp: new Date().toISOString(),
        content_preview: 'historic links',
        content: [
          {
            type: 'text',
            text: [
              'Attached files:',
              '- /old/home/.agor/uploads/historic.png',
              '',
              'See https://example.com/historic and agor://kb/team/runbook.md',
            ].join('\n'),
          },
        ],
      };
      await new MessagesRepository(db).create(message);

      await backfillLegacySessionLinks({ db, sessionId: session.session_id, uploadRoot });
      await backfillLegacySessionLinks({ db, sessionId: session.session_id, uploadRoot });

      const links = await new LinksRepository(db).findAll({ sessionId: session.session_id });
      expect(links).toHaveLength(3);
      expect(links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'upload',
            kind: 'image',
            file_path: 'historic.png',
            source_message_id: message.message_id,
          }),
          expect.objectContaining({ source: 'parsed', url: 'https://example.com/historic' }),
          expect.objectContaining({ source: 'parsed', ref_uri: 'agor://kb/team/runbook.md' }),
        ])
      );
    }
  );

  dbTest(
    'rejects legacy attachment paths that do not resolve inside the upload root',
    async ({ db }) => {
      const branch = await seedLinkBranch(db);
      const session = await seedLinkSession(db, branch.branch_id, 'owner' as UUID);
      const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-legacy-links-root-'));
      const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-legacy-links-outside-'));
      tempRoots.push(uploadRoot, outsideRoot);
      const outsidePath = path.join(outsideRoot, 'secret.txt');
      await fs.writeFile(outsidePath, 'secret');
      await fs.writeFile(
        path.join(uploadRoot, 'secret.txt'),
        'unrelated upload with same basename'
      );
      await new MessagesRepository(db).create({
        message_id: generateId(),
        session_id: session.session_id,
        type: 'user',
        role: MessageRole.USER,
        index: 0,
        timestamp: new Date().toISOString(),
        content_preview: 'unsafe attachment',
        content: `Attached files:\n- ${outsidePath}`,
      });

      await backfillLegacySessionLinks({ db, sessionId: session.session_id, uploadRoot });

      await expect(
        new LinksRepository(db).findAll({ sessionId: session.session_id })
      ).resolves.toEqual([]);
    }
  );
});
