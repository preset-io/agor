import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestClient } from '@agor/core/api';
import { BadRequest, errorHandler, feathers, feathersExpress, rest } from '@agor/core/feathers';
import { KNOWLEDGE_TRANSFER } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { KnowledgeProgress } from './progress';
import { importKnowledge, knowledgeTransferClient } from './transfer';
import { transferRequest } from './transfer-errors';

it('provides compatibility guidance when a daemon supplies no field details', async () => {
  const progress = new KnowledgeProgress({ isTTY: false, write: () => true });
  await expect(
    transferRequest(progress, 'Planning: destination inventory', 'GET', async () => {
      throw Object.assign(new Error('untrusted-proxy-body'), { code: 400 });
    })
  ).rejects.toThrow('no field details supplied by daemon');
});

it.each([400, 401, 403, 404, 405, 409, 413, 429, 500, undefined])(
  'sanitizes remote errors (%s), including old daemons without issues',
  async (code) => {
    const progress = new KnowledgeProgress({ isTTY: false, write: () => true });
    const secret = 'private-token\u001b[2J\nprivate body';
    try {
      await transferRequest(progress, 'Importing document', 'POST', async () => {
        throw Object.assign(new Error(secret), {
          code,
          data: {
            request: secret,
            issues: [{ path: ['entry', 'frontmatter', secret], message: secret }],
          },
        });
      });
      throw new Error('Expected rejection');
    } catch (error) {
      expect((error as Error).message).toContain('Importing document — POST /kb/transfers');
      expect((error as Error).message).not.toContain(secret);
      if (code === 400)
        expect((error as Error).message).toContain('entry.frontmatter: Invalid value');
      if (code === 409) expect((error as Error).message).toContain('nothing is overwritten');
    } finally {
      progress.close();
    }
  }
);

describe.skipIf(process.platform === 'win32')('transfer failure diagnostics', () => {
  it('reports the inventory boundary and legacy field issues instead of losing them', async () => {
    const app = feathersExpress(feathers());
    app.configure(rest());
    // A pre-fix daemon error, transported by the real Feathers REST client.
    app.use(KNOWLEDGE_TRANSFER.path, {
      async find() {
        throw new BadRequest('Invalid Knowledge transfer request', {
          issues: [
            { path: ['cursor'], message: 'Too big: expected string to have <=100 characters' },
          ],
        });
      },
    });
    app.use(errorHandler());
    const server = await app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const directory = await mkdtemp(join(tmpdir(), 'kb-invalid-'));
    const progress = new KnowledgeProgress({ isTTY: false, write: () => true });
    try {
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          format: KNOWLEDGE_TRANSFER.format,
          version: 1,
          completed: true,
          consistency: 'per-document-version; non-atomic-inventory',
          exported_at: '2026-09-22T12:00:00Z',
          namespace: {
            slug: 'synthetic',
            display_name: 'Synthetic',
            description: null,
            provenance: {},
          },
          documents: [],
          omissions: [],
        })
      );
      const client = knowledgeTransferClient(
        await createRestClient(`http://127.0.0.1:${address.port}`)
      );
      for (const dryRun of [false, true])
        await expect(
          importKnowledge(
            client,
            {
              namespace: 'agor-cloud-team',
              directory,
              dryRun,
              resume: true,
              sourceIdentity: 'synthetic',
              signal: new AbortController().signal,
            },
            progress
          )
        ).rejects.toThrow(/Planning: destination inventory.*GET \/kb\/transfers.*cursor.*exceeds/s);
    } finally {
      progress.close();
      await app.teardown();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
