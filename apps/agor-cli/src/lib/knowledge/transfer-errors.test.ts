import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestClient } from '@agor/core/api';
import { BadRequest, errorHandler, feathers, feathersExpress, rest } from '@agor/core/feathers';
import { serializeKnowledgeYaml } from '@agor/core/knowledge';
import { KNOWLEDGE_TRANSFER } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { KnowledgeProgress } from './progress';
import { importKnowledge, knowledgeTransferClient } from './transfer';
import { TransferFailures, TransferRequestError, transferRequest } from './transfer-errors';

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
        join(directory, 'manifest.yaml'),
        serializeKnowledgeYaml({
          format: KNOWLEDGE_TRANSFER.format,
          version: 2,
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

it.each([
  ['Importing document', 500, '', true],
  ['Reconciling references', 409, '', true],
  ['Exporting document', 404, '', true],
  ['Importing document', 413, '', true],
  ['Exporting document', 400, 'Unsupported or missing Knowledge version', true],
  ['Importing document', 400, 'Content does not match transfer plan', true],
  ['Importing document', 400, 'Invalid Knowledge transfer request', false],
  ['Importing document', 400, 'Import exceeds namespace transfer limits', false],
  ['Importing document', 401, '', false],
  ['Importing document', 403, '', false],
  ['Importing document', 404, '', false],
  ['Importing document', 405, '', false],
  ['Importing document', 429, '', false],
  ['Importing document', 502, '', false],
  ['Importing document', 503, '', false],
  ['Importing document', 504, '', false],
  ['Importing document', undefined, '', false],
  ['Planning: source inventory', 500, '', false],
  ['Creating import namespace', 409, '', false],
] as const)('classifies %s HTTP %s (%s): continue=%s', async (stage, code, message, continuing) => {
  const progress = new KnowledgeProgress({ isTTY: false, write: () => true });
  try {
    await expect(
      transferRequest(progress, stage, 'POST', async () => {
        throw Object.assign(new Error(message), { code });
      })
    ).rejects.toMatchObject({ continueDocuments: continuing });
  } finally {
    progress.close();
  }
});

it('bounds partial failure diagnostics and never continues arbitrary local errors', () => {
  const lines: string[] = [];
  const progress = new KnowledgeProgress({
    isTTY: false,
    write: (text) => {
      lines.push(String(text));
      return true;
    },
  });
  try {
    const failures = new TransferFailures();
    for (let i = 0; i < 25; i++)
      failures.capture(
        new TransferRequestError('Sanitized reason', true),
        'untrusted key',
        progress,
        'private source metadata'
      );
    expect(lines).toHaveLength(20);
    expect(lines.join('')).not.toContain('untrusted');
    expect(lines.join('')).not.toContain('private');
    expect(() => failures.finish('Partial', 'Resolve before resume')).toThrow(
      '25 failed or unconfirmed'
    );
    expect(() => failures.finish('Partial', 'Resolve before resume')).toThrow(
      '5 additional failures omitted'
    );
    expect(() => failures.capture(new Error('Unsafe local file'), 'd000001', progress)).toThrow(
      'Unsafe local file'
    );
  } finally {
    progress.close();
  }
});
