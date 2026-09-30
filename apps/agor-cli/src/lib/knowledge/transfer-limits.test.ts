import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeTransferManifest, transferSha256 } from '@agor/core/knowledge';
import type { KnowledgeTransferManifest } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeProgress } from './progress';
import { importKnowledge } from './transfer';

// Scale the aggregate ceiling down to keep the quote-expansion regression cheap;
// individual requests and raw content still fit their real production limits.
vi.mock('@agor/core/types', async (original) => {
  const actual = await original<typeof import('@agor/core/types')>();
  return {
    ...actual,
    KNOWLEDGE_TRANSFER: { ...actual.KNOWLEDGE_TRANSFER, maxTotalRequestBytes: 16 * 1024 },
  };
});

describe.skipIf(process.platform === 'win32')('import plan aggregate limits', () => {
  it('rejects quote-expanded aggregate requests before any write, including dry-run and resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kb-transfer-limit-'));
    const progress = new KnowledgeProgress({ isTTY: false, write: () => true });
    const content = '"'.repeat(3 * 1024);
    const hash = transferSha256(content);
    const manifest: KnowledgeTransferManifest = {
      format: 'agor-knowledge-namespace',
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
      omissions: [],
      documents: Array.from({ length: 4 }, (_, index) => ({
        key: `d${String(index + 1).padStart(6, '0')}`,
        path: `${index}.md`,
        title: 'Synthetic',
        icon_emoji: null,
        kind: 'doc',
        status: 'published',
        sha256: hash,
        bytes: Buffer.byteLength(content),
        frontmatter: null,
        provenance: {},
      })),
    };
    const client = { find: vi.fn(), get: vi.fn(), create: vi.fn() };
    try {
      await writeFile(join(directory, 'manifest.json'), serializeTransferManifest(manifest));
      for (const doc of manifest.documents)
        await writeFile(join(directory, `${doc.key}-${hash}.md`), content);
      for (const mode of [
        { dryRun: false, resume: false },
        { dryRun: true, resume: false },
        { dryRun: false, resume: true },
      ]) {
        await expect(
          importKnowledge(
            client,
            {
              ...mode,
              namespace: 'destination',
              directory,
              sourceIdentity: 'synthetic',
              signal: new AbortController().signal,
            },
            progress
          )
        ).rejects.toThrow('Encoded import plan exceeds namespace transfer limit');
      }
      expect(client.create).not.toHaveBeenCalled();
      expect(client.find).not.toHaveBeenCalled();
    } finally {
      progress.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
