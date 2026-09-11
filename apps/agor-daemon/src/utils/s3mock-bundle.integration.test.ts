import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type { BranchID } from '@agor/core/types';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { expect, it, vi } from 'vitest';
import {
  packBranchBundle,
  restoreBranchBundle,
} from '../../../../packages/executor/src/commands/branch-bundle.js';
import { simpleGit } from '../../../../packages/git/src/index.js';
import { S3UploadStagingStore } from './s3-upload-staging-store.js';

// Opt-in against an already running local emulator. Never starts services or
// uses ambient AWS credentials. Every write is in a fresh disposable prefix.
const endpoint = process.env.AGOR_TEST_S3MOCK_ENDPOINT;
it.skipIf(!endpoint)(
  'roundtrips a dirty clone through real SDK multipart S3Mock storage',
  async () => {
    const url = new URL(endpoint!);
    if (
      url.protocol !== 'http:' ||
      !/^(localhost|s3mock|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        url.hostname
      )
    )
      throw new Error('S3Mock integration requires a local HTTP endpoint');
    const client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    });
    vi.stubEnv('AGOR_S3MOCK_CHECKSUM_COMPATIBILITY', 'true');
    const prefix = `disposable-integration-${randomUUID()}`;
    const bucket = 'agor-dev-storage';
    const store = new S3UploadStagingStore({ bucket, prefix }, { client }).branchBundles();
    const owner = { tenantId: 'fixture', branchId: 'fixture' as BranchID, operationId: 'clone' };
    const keys = [
      `${prefix}/branch-bundles/fixture/fixture/clone.tgz`,
      `${prefix}/branch-bundles/fixture/fixture/small.tgz`,
      `${prefix}/bad-checksum`,
    ];
    const dir = await mkdtemp(join(tmpdir(), 'agor-s3mock-'));
    try {
      const small = await store.upload(
        { ...owner, operationId: 'small' },
        Readable.from(['small'])
      );
      expect(await (await store.read(owner, small)).toArray()).toEqual([Buffer.from('small')]);
      // The compatibility path still asks the provider to reject corrupt bytes.
      await expect(
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: keys[2],
            Body: Buffer.from('corrupt'),
            ChecksumAlgorithm: 'SHA256',
            ChecksumSHA256: Buffer.alloc(32).toString('base64'),
          })
        )
      ).rejects.toMatchObject({ name: 'BadRequest', message: expect.stringMatching(/checksum/i) });

      const origin = join(dir, 'origin');
      const root = join(dir, 'clone');
      await mkdir(origin);
      const git = simpleGit(origin);
      await git.init();
      await git.addConfig('user.name', 'Fixture');
      await git.addConfig('user.email', 'fixture@example.invalid');
      await writeFile(join(origin, 'tracked'), 'committed');
      await writeFile(join(origin, '.gitignore'), 'ignored\n');
      await git.add('.');
      await git.commit('fixture');
      await simpleGit().clone(origin, root, ['--no-hardlinks']);
      await writeFile(join(root, 'tracked'), 'staged');
      await simpleGit(root).add('tracked');
      await writeFile(join(root, 'tracked'), 'dirty');
      await writeFile(join(root, 'untracked'), 'untracked');
      await chmod(join(root, 'untracked'), 0o751);
      await symlink('tracked', join(root, 'link'));
      // Incompressible ignored bytes force the real lib-storage multipart path.
      const ignored = randomBytes(9 * 1024 * 1024);
      await writeFile(join(root, 'ignored'), ignored);
      const before = await simpleGit(root).raw(['status', '--porcelain=v1', '--ignored']);
      const index = await readFile(join(root, '.git', 'index'));
      const stream = new PassThrough();
      const [digest, receipt] = await Promise.all([
        packBranchBundle(root, stream),
        store.upload(owner, stream),
      ]);
      expect(receipt.sha256).toBe(digest.sha256);
      expect(receipt.bytes).toBe(digest.bytes);
      expect(receipt.providerChecksum).toMatch(/-2$/);
      const restored = join(dir, 'restored');
      await restoreBranchBundle(await store.read(owner, receipt), restored, digest);
      // Git status may refresh the index stat cache; compare bytes before it.
      expect(await readFile(join(restored, '.git', 'index'))).toEqual(index);
      expect(await simpleGit(restored).raw(['status', '--porcelain=v1', '--ignored'])).toBe(before);
      expect(await readFile(join(restored, 'tracked'), 'utf8')).toBe('dirty');
      expect(
        createHash('sha256')
          .update(await readFile(join(restored, 'ignored')))
          .digest('hex')
      ).toBe(createHash('sha256').update(ignored).digest('hex'));
      expect((await lstat(join(restored, 'untracked'))).mode & 0o777).toBe(0o751);
      expect(await readlink(join(restored, 'link'))).toBe('tracked');
    } finally {
      try {
        for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
      } finally {
        vi.unstubAllEnvs();
        client.destroy();
        await rm(dir, { recursive: true, force: true });
      }
    }
  },
  60_000
);
