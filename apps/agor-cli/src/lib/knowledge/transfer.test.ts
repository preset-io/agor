import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTenantScopedDatabaseProxy,
  generateId,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  KnowledgeTransferRepository,
  UsersRepository,
} from '@agor/core/db';
import type { KnowledgeDocument, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { Parser } from '@oclif/core';
import { describe, expect, it, vi } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { KnowledgeTransfersService } from '../../../../agor-daemon/src/services/knowledge-transfers';
import KnowledgeImport from '../../commands/kb/import';
import { KnowledgeDirectory } from './directory';
import { KnowledgeProgress } from './progress';
import { exportKnowledge } from './repository-export';
import { importKnowledge, type knowledgeTransferClient } from './transfer';

function progress() {
  const lines: string[] = [];
  return {
    lines,
    reporter: new KnowledgeProgress({
      isTTY: false,
      write: (chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      },
    }),
  };
}
function clientFor(
  service: KnowledgeTransfersService,
  user: User
): ReturnType<typeof knowledgeTransferClient> {
  return {
    find: (params) => service.find({ user, query: params?.query }),
    get: (id, params) => service.get(id, { user, query: params?.query }),
    create: (data) => service.create(data, { user }),
  };
}
describe.skipIf(process.platform === 'win32')('Knowledge CLI workflow', () => {
  it('parses the reported resume/apply invocation and its read-only diagnostic equivalent', async () => {
    for (const mode of ['--apply', '--dry-run']) {
      const { args, flags } = await Parser.parse(
        ['--namespace', 'agor-cloud-team', 'agor-cloud-team/', mode, '--resume'],
        { args: KnowledgeImport.args, flags: KnowledgeImport.flags }
      );
      expect(args.directory).toBe('agor-cloud-team/');
      expect(flags.namespace).toBe('agor-cloud-team');
      expect(flags.resume).toBe(true);
      expect(Boolean(flags.apply)).toBe(mode === '--apply');
    }
  });
  dbTest(
    'plans without writes, exports hashes, resumes without body fetch, imports privately and detects edits',
    async ({ db }) => {
      const root = await mkdtemp(join(tmpdir(), 'kb-transfer-test-'));
      const log = progress();
      try {
        const admin = (await new UsersRepository(db).create({
          email: `${generateId()}@test.invalid`,
          role: ROLES.ADMIN,
          name: 'Admin',
        })) as User;
        const member = (await new UsersRepository(db).create({
          email: `${generateId()}@test.invalid`,
          role: ROLES.MEMBER,
          name: 'Importer',
        })) as User;
        const source = await new KnowledgeNamespaceRepository(db).create({
          slug: 'source',
          display_name: 'Source',
          owner_user_id: admin.user_id,
        });
        const docs = new KnowledgeDocumentRepository(db);
        const original = await docs.create({
          namespace_id: source.namespace_id,
          path: 'guide',
          title: 'Guide',
          content_text: '# Synthetic café\r\n',
          status: 'draft',
          created_by: admin.user_id,
          visibility: 'private',
        });
        const service = new KnowledgeTransfersService(
          createTenantScopedDatabaseProxy(db, { requireScope: false })
        );
        const client = clientFor(service, admin);
        const options = {
          namespace: 'source',
          directory: join(root, 'bundle'),
          dryRun: true,
          resume: false,
          sourceIdentity: 'synthetic-deployment',
          signal: new AbortController().signal,
        };
        expect(await exportKnowledge(client, options, log.reporter)).toMatchObject({
          dryRun: true,
          pending: 1,
        });
        await expect(stat(options.directory)).rejects.toMatchObject({ code: 'ENOENT' });
        const get = vi.spyOn(client, 'get');
        expect(
          await exportKnowledge(client, { ...options, dryRun: false }, log.reporter)
        ).toMatchObject({ copied: 1 });
        expect(get).toHaveBeenCalledTimes(1);
        get.mockClear();
        expect(
          await exportKnowledge(client, { ...options, dryRun: false, resume: true }, log.reporter)
        ).toMatchObject({ copied: 0, unchanged: 1 });
        expect(get).not.toHaveBeenCalled();
        const importer = clientFor(service, member);
        // Exercise the real command parser: omitted booleans need explicit defaults
        // before they cross the strictly validated transfer API boundary.
        const { flags } = await Parser.parse([options.directory, '--namespace', 'destination'], {
          args: KnowledgeImport.args,
          flags: KnowledgeImport.flags,
        });
        const incoming = { ...options, namespace: flags.namespace, resume: flags.resume };
        expect(await importKnowledge(importer, incoming, log.reporter)).toMatchObject({
          dryRun: true,
          pending: 1,
        });
        expect(await new KnowledgeNamespaceRepository(db).findBySlug('destination')).toBeNull();
        expect(
          await importKnowledge(importer, { ...incoming, dryRun: false }, log.reporter)
        ).toMatchObject({ created: 1 });
        const replayWrites = vi.spyOn(importer, 'create');
        expect(
          await importKnowledge(
            importer,
            { ...incoming, dryRun: false, resume: true },
            log.reporter
          )
        ).toMatchObject({ created: 0, unchanged: 1 });
        expect(replayWrites.mock.calls.some(([request]) => request.action === 'reconcile')).toBe(
          false
        );
        const targetNs = await new KnowledgeNamespaceRepository(db).findBySlug('destination');
        const imported = await docs.findByNamespaceAndPath(targetNs!.namespace_id, 'guide');
        expect(imported).toMatchObject({
          visibility: 'private',
          created_by: member.user_id,
          status: 'draft',
        });
        expect(
          await new KnowledgeDocumentVersionRepository(db).findAll({
            document_id: imported!.document_id,
          })
        ).toHaveLength(1);
        await docs.update(imported!.document_id, { title: 'Changed since import' });
        await expect(
          importKnowledge(importer, { ...incoming, dryRun: false, resume: true }, log.reporter)
        ).rejects.toThrow('conflict');
        expect(log.lines.join('')).toContain('1 / 1');
        expect(log.lines.join('')).not.toContain('Synthetic café');
        await docs.update(original.document_id, { content_text: 'changed source' });
        expect(
          await exportKnowledge(client, { ...options, dryRun: false, resume: true }, log.reporter)
        ).toMatchObject({ copied: 1 });
        await writeFile(join(options.directory, 'docs/guide.md'), 'independent local edit');
        await expect(
          exportKnowledge(client, { ...options, dryRun: false, resume: true }, log.reporter)
        ).rejects.toThrow('Local content differs');
      } finally {
        log.reporter.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
  it('rejects symlink, hardlink, oversized and invalid UTF-8 input without touching targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-directory-test-'));
    let directory: KnowledgeDirectory | undefined;
    try {
      const outside = join(root, 'outside');
      await writeFile(outside, 'secret');
      directory = await KnowledgeDirectory.open(join(root, 'bundle'), true);
      await directory.lock();
      await symlink(outside, join(root, 'bundle', 'd000001.md'));
      await expect(directory.read('d000001.md', 100)).rejects.toThrow();
      await link(outside, join(root, 'bundle', 'd000002.md'));
      await expect(directory.read('d000002.md', 100)).rejects.toThrow('Unsafe');
      await writeFile(join(root, 'bundle', 'd000003.md'), Buffer.from([0xff]));
      await expect(directory.read('d000003.md', 100)).rejects.toThrow();
      await directory.write('d000004.md', '12345');
      await expect(directory.read('d000004.md', 4)).rejects.toThrow('oversized');
      await expect(directory.read('../outside', 100)).rejects.toThrow('Unsafe');
      expect(await readFile(outside, 'utf8')).toBe('secret');
    } finally {
      await directory?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('Knowledge interrupted transfer', () => {
  dbTest(
    'recovers a committed create whose acknowledgement was lost, and rejects corrupt bundles before writing',
    async ({ db }) => {
      const root = await mkdtemp(join(tmpdir(), 'kb-resume-test-'));
      const log = progress();
      try {
        const admin = (await new UsersRepository(db).create({
          email: `${generateId()}@test.invalid`,
          role: ROLES.ADMIN,
        })) as User;
        const ns = await new KnowledgeNamespaceRepository(db).create({
          slug: 'source',
          display_name: 'Source',
          owner_user_id: admin.user_id,
        });
        await new KnowledgeDocumentRepository(db).create({
          namespace_id: ns.namespace_id,
          path: 'a.md',
          content_text: 'Synthetic',
          created_by: admin.user_id,
        });
        const service = new KnowledgeTransfersService(
          createTenantScopedDatabaseProxy(db, { requireScope: false })
        );
        const client = clientFor(service, admin);
        const options = {
          namespace: 'source',
          directory: join(root, 'bundle'),
          dryRun: false,
          resume: false,
          sourceIdentity: 'test',
          signal: new AbortController().signal,
        };
        await exportKnowledge(client, options, log.reporter);
        const normalCreate = client.create.bind(client);
        let lost = false;
        client.create = async (data) => {
          const result = await normalCreate(data);
          if (data.action === 'document' && !lost) {
            lost = true;
            throw new Error('Synthetic lost acknowledgement');
          }
          return result;
        };
        await expect(
          importKnowledge(client, { ...options, namespace: 'destination' }, log.reporter)
        ).rejects.toThrow('Importing document — POST /kb/transfers');
        client.create = normalCreate;
        expect(
          await importKnowledge(
            client,
            { ...options, namespace: 'destination', resume: true },
            log.reporter
          )
        ).toMatchObject({ created: 0, unchanged: 1 });
        await writeFile(join(options.directory, 'docs/a.md'), 'tampered without a header');
        const create = vi.spyOn(client, 'create');
        await expect(
          importKnowledge(client, { ...options, namespace: 'not-created' }, log.reporter)
        ).rejects.toThrow('YAML header');
        expect(create).not.toHaveBeenCalled();
      } finally {
        log.reporter.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
  dbTest(
    'cancellation retains a partial export and unknown backend hashes are verified on resume',
    async ({ db }) => {
      const root = await mkdtemp(join(tmpdir(), 'kb-cancel-test-'));
      const log = progress();
      try {
        const admin = (await new UsersRepository(db).create({
          email: `${generateId()}@test.invalid`,
          role: ROLES.ADMIN,
        })) as User;
        const ns = await new KnowledgeNamespaceRepository(db).create({
          slug: 'source',
          display_name: 'Source',
          owner_user_id: admin.user_id,
        });
        await new KnowledgeDocumentRepository(db).create({
          namespace_id: ns.namespace_id,
          path: 'a.md',
          content_text: '',
          created_by: admin.user_id,
        });
        const service = new KnowledgeTransfersService(
          createTenantScopedDatabaseProxy(db, { requireScope: false })
        );
        const client = clientFor(service, admin);
        const normalFind = client.find.bind(client);
        client.find = async (params) => {
          const page = await normalFind(params);
          page.entries.forEach((entry) => {
            entry.sha256 = null;
            entry.bytes = null;
          });
          return page;
        };
        const controller = new AbortController();
        const normalGet = client.get.bind(client);
        client.get = async (id, params) => {
          const body = await normalGet(id, params);
          controller.abort();
          return body;
        };
        const options = {
          namespace: 'source',
          directory: join(root, 'bundle'),
          dryRun: false,
          resume: false,
          sourceIdentity: 'test',
          signal: controller.signal,
        };
        await expect(exportKnowledge(client, options, log.reporter)).rejects.toThrow('Cancelled');
        await expect(readFile(join(options.directory, 'manifest.yaml'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        client.get = normalGet;
        const result = await exportKnowledge(
          client,
          { ...options, resume: true, signal: new AbortController().signal },
          log.reporter
        );
        expect(result).toMatchObject({ documents: 1, copied: 1 });
        expect(log.lines.join('')).toContain('1 unknown hashes');
      } finally {
        log.reporter.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe.skipIf(process.platform === 'win32')('Knowledge best-effort document transfers', () => {
  dbTest(
    'retains later successes, rolls back a failed document+receipt, and resumes uncertain writes and references',
    async ({ db }) => {
      const root = await mkdtemp(join(tmpdir(), 'kb-partial-test-'));
      const log = progress();
      try {
        const admin = (await new UsersRepository(db).create({
          email: `${generateId()}@test.invalid`,
          role: ROLES.ADMIN,
        })) as User;
        const namespaces = new KnowledgeNamespaceRepository(db);
        const source = await namespaces.create({
          slug: 'partial-source',
          display_name: 'Synthetic',
          owner_user_id: admin.user_id,
        });
        const docs = new KnowledgeDocumentRepository(db);
        const originals: KnowledgeDocument[] = [];
        for (const path of ['a.md', 'b.md', 'c.md', 'd.md'])
          originals.push(
            await docs.create({
              namespace_id: source.namespace_id,
              path,
              content_text: 'private synthetic body',
              created_by: admin.user_id,
            })
          );
        const service = new KnowledgeTransfersService(
          createTenantScopedDatabaseProxy(db, { requireScope: false })
        );
        const client = clientFor(service, admin);
        const options = {
          namespace: 'partial-source',
          directory: join(root, 'repo'),
          dryRun: false,
          resume: false,
          sourceIdentity: 'synthetic',
          signal: new AbortController().signal,
        };
        const normalGet = client.get.bind(client);
        const failedGet = vi.spyOn(client, 'get').mockImplementation(async (id, params) => {
          if (id === originals[1].document_id)
            throw Object.assign(new Error('private remote content'), { code: 500 });
          return normalGet(id, params);
        });
        await expect(exportKnowledge(client, options, log.reporter)).rejects.toThrow(
          '3 bodies cached; 0 unchanged; 1 failed or unconfirmed'
        );
        expect(failedGet).toHaveBeenCalledTimes(4);
        await expect(readFile(join(options.directory, 'manifest.yaml'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        failedGet.mockImplementation(normalGet).mockClear();
        await expect(
          exportKnowledge(client, { ...options, resume: true }, log.reporter)
        ).resolves.toMatchObject({ copied: 1, unchanged: 3 });
        expect(failedGet).toHaveBeenCalledTimes(1);
        expect(failedGet.mock.calls[0][0]).toBe(originals[1].document_id);

        const originalRecord = KnowledgeTransferRepository.prototype.record;
        const record = vi
          .spyOn(KnowledgeTransferRepository.prototype, 'record')
          .mockImplementation(async function (this: KnowledgeTransferRepository, ...args) {
            if (args[3] === 'd000002')
              throw Object.assign(new Error('private transaction failure'), { code: 500 });
            return originalRecord.apply(this, args);
          });
        const normalCreate = client.create.bind(client);
        const attemptedPaths = new Map<string, string>();
        const create = vi.spyOn(client, 'create').mockImplementation(async (data) => {
          if (data.action === 'document') attemptedPaths.set(data.entry.key, data.entry.path);
          const result = await normalCreate(data);
          if (data.action === 'document' && data.entry.key === 'd000003')
            throw Object.assign(new Error('private lost acknowledgement'), { code: 500 });
          return result;
        });
        const incoming = { ...options, namespace: 'partial-destination' };
        await expect(importKnowledge(client, incoming, log.reporter)).rejects.toThrow(
          '2 creates acknowledged; 0 unchanged; 2 failed or unconfirmed'
        );
        expect(attemptedPaths.size).toBe(4);
        expect(create.mock.calls.some(([data]) => data.action === 'reconcile')).toBe(false);
        const target = (await namespaces.findBySlug(incoming.namespace))!;
        // Failure after document creation but before receipt insertion rolls back only that request.
        expect(
          await docs.findByNamespaceAndPath(target.namespace_id, attemptedPaths.get('d000002')!)
        ).toBeNull();
        for (const key of ['d000001', 'd000003', 'd000004'])
          expect(
            await docs.findByNamespaceAndPath(target.namespace_id, attemptedPaths.get(key)!)
          ).not.toBeNull();
        record.mockRestore();
        create.mockImplementation(normalCreate).mockClear();
        await expect(
          importKnowledge(client, { ...incoming, resume: true, dryRun: true }, log.reporter)
        ).resolves.toMatchObject({ pending: 1, unchanged: 3 });
        expect(create).not.toHaveBeenCalled();

        // A reconciliation error does not block the remaining reference checks.
        create.mockImplementation(async (data) => {
          if (data.action === 'reconcile' && data.key === 'd000002')
            throw Object.assign(new Error('private reference error'), { code: 500 });
          return normalCreate(data);
        });
        await expect(
          importKnowledge(client, { ...incoming, resume: true }, log.reporter)
        ).rejects.toThrow('3 / 4 reference checks acknowledged; 1 failed or unconfirmed');
        expect(create.mock.calls.filter(([data]) => data.action === 'document')).toHaveLength(1);
        expect(create.mock.calls.filter(([data]) => data.action === 'reconcile')).toHaveLength(4);
        create.mockImplementation(normalCreate).mockClear();
        await expect(
          importKnowledge(client, { ...incoming, resume: true }, log.reporter)
        ).resolves.toMatchObject({ created: 0, unchanged: 4 });
        expect(create.mock.calls.filter(([data]) => data.action === 'document')).toHaveLength(0);
        expect(
          create.mock.calls
            .filter(([data]) => data.action === 'reconcile')
            .map(([data]) => data.action === 'reconcile' && data.key)
        ).toEqual(['d000002']);
        for (const path of attemptedPaths.values()) {
          const doc = (await docs.findByNamespaceAndPath(target.namespace_id, path))!;
          expect(
            await new KnowledgeDocumentVersionRepository(db).findAll({
              document_id: doc.document_id,
            })
          ).toHaveLength(1);
        }
        expect(log.lines.join('')).not.toContain('private ');
      } finally {
        vi.restoreAllMocks();
        log.reporter.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
