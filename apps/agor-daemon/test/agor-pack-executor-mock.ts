/**
 * `vi.mock('…/agor-pack-executor', …)` for pack tests: the collect leg stages a
 * fragment exactly like `branch.pack.collect` does. Kept apart from the pack
 * fixture so the mock factory never imports modules that import the mocked one.
 */

import { Readable } from 'node:stream';
import { AgorPackWriter } from '@agor/core/agor-pack';
import type { TenantID } from '@agor/core/types';
import { getBlobStagingStore } from '../src/utils/upload-staging.js';

export async function packExecutorMock(
  importOriginal: () => Promise<typeof import('../src/services/agor-pack-executor.js')>
) {
  return {
    ...(await importOriginal()),
    runAgorPackExecutorCommand: async (
      ctx: { tenantId: TenantID; user: { user_id: string } },
      input: { params: { exportId: string } }
    ) => {
      const writer = new AgorPackWriter();
      const chunks: Buffer[] = [];
      writer.output.on('data', (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise((resolve) => writer.output.on('end', resolve));
      writer.addJson('teammates/t00/git/state.json', {
        version: 1,
        head_sha: 'a'.repeat(40),
        ref: 'ada',
        deleted: [],
      });
      writer.addBuffer('teammates/t00/sdk-home/claude/projects/-src-ada/memory/MEMORY.md', '# me');
      writer.finishFragment();
      await done;
      const staged = await getBlobStagingStore().stage({
        owner: {
          tenantId: ctx.tenantId,
          kind: 'agor-pack',
          scopeId: input.params.exportId,
          createdBy: ctx.user.user_id as never,
        },
        name: 'fragment.zip',
        mimeType: 'application/zip',
        body: Readable.from([Buffer.concat(chunks)]),
      });
      return {
        fragmentRef: staged.ref,
        git: {
          mode: 'bundle',
          head_sha: 'a'.repeat(40),
          unpushed_commits: 3,
          dirty_files: 0,
          deleted_files: 0,
          bundle: false,
          skipped_files: [],
        },
        claudeMemory: { files: 1, bytes: 4 },
      };
    },
  };
}
