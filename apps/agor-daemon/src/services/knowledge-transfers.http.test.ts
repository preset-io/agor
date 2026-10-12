import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRestClient } from '@agor/core/api';
import {
  createTenantScopedDatabaseProxy,
  KnowledgeDocumentRepository,
  KnowledgeDocumentVersionRepository,
  KnowledgeNamespaceRepository,
  UserApiKeysRepository,
  UsersRepository,
} from '@agor/core/db';
import { type AuthenticationService, authenticate } from '@agor/core/feathers';
import { transferDigest, transferSha256 } from '@agor/core/knowledge';
import {
  KNOWLEDGE_TRANSFER,
  type KnowledgeDocumentID,
  type KnowledgeTransferManifest,
  ROLES,
} from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { KnowledgeProgress } from '../../../agor-cli/src/lib/knowledge/progress';
import { loadKnowledgeRepository } from '../../../agor-cli/src/lib/knowledge/repository';
import { writeRepositoryFixture } from '../../../agor-cli/src/lib/knowledge/repository.test-helpers';
import { RepositoryDirectory } from '../../../agor-cli/src/lib/knowledge/repository-directory';
import {
  importKnowledge,
  knowledgeTransferClient,
} from '../../../agor-cli/src/lib/knowledge/transfer';
import { boardMetadataTestApp } from '../../test/board-metadata-app';
import { ApiKeyStrategy } from '../auth/api-key-strategy';
import type { RegisterHooksContext } from '../register-hooks';
import { KnowledgeTransfersService } from './knowledge-transfers';

describe.skipIf(process.platform === 'win32')('Knowledge transfer REST boundary', () => {
  dbTest(
    'real serialization, auth and tenant hooks preserve plan/apply/resume contracts',
    async ({ db }) => {
      const owner = await new UsersRepository(db).create({
        email: 'importer@test.invalid',
        name: 'Importer',
        role: ROLES.MEMBER,
      });
      const stranger = await new UsersRepository(db).create({
        email: 'stranger@test.invalid',
        name: 'Stranger',
        role: ROLES.MEMBER,
      });
      const guarded = createTenantScopedDatabaseProxy(db, { requireScope: true });
      const server = await boardMetadataTestApp(
        guarded,
        {
          database: { dialect: 'sqlite' },
          multi_tenancy: { mode: 'static', static_tenant_id: 'transfer-fixture' },
          execution: {},
        } as RegisterHooksContext['config'],
        false,
        false,
        false,
        async (app) => {
          const strategy = new ApiKeyStrategy();
          strategy.setDependencies(new UserApiKeysRepository(guarded), app.service('users'));
          (app.service('authentication') as unknown as AuthenticationService).register(
            'api-key',
            strategy
          );
          app.set('authentication', {
            ...app.get('authentication'),
            authStrategies: ['api-key', 'jwt'],
          });
          app.use(KNOWLEDGE_TRANSFER.path, new KnowledgeTransfersService(guarded), {
            methods: ['find', 'get', 'create'],
          });
          // Match production's two-strategy admission before the helper's JWT
          // hook (which skips already-authenticated calls).
          app
            .service(KNOWLEDGE_TRANSFER.path)
            .hooks({ before: { all: [authenticate({ strategies: ['api-key', 'jwt'] })] } });
        }
      );
      const directory = await mkdtemp(join(tmpdir(), 'kb-http-'));
      const lines: string[] = [];
      const progress = new KnowledgeProgress({
        isTTY: false,
        write: (line) => {
          lines.push(String(line));
          return true;
        },
      });
      const content = '# Synthetic only\n';
      let manifest: KnowledgeTransferManifest = {
        format: KNOWLEDGE_TRANSFER.format,
        version: 1,
        completed: true,
        consistency: 'per-document-version; non-atomic-inventory',
        exported_at: '2026-09-22T12:00:00Z',
        namespace: {
          slug: 'synthetic-source',
          display_name: 'Synthetic',
          description: null,
          provenance: {},
        },
        omissions: [],
        documents: Array.from({ length: 101 }, (_, index) => index + 1).map((n) => ({
          key: `d${String(n).padStart(6, '0')}`,
          path: `${n}.md`,
          title: `Synthetic ${n}`,
          icon_emoji: null,
          kind: 'doc',
          status: 'published',
          sha256: transferSha256(content),
          bytes: Buffer.byteLength(content),
          frontmatter: null,
          provenance: {},
        })),
      };
      const options = {
        namespace: 'agor-cloud-team',
        directory,
        dryRun: true,
        resume: false,
        sourceIdentity: 'synthetic-target',
        signal: new AbortController().signal,
      };
      try {
        await writeRepositoryFixture(directory, manifest, content);
        const fixture = await RepositoryDirectory.open(directory);
        try {
          manifest = (await loadKnowledgeRepository(fixture, options.namespace)).manifest;
        } finally {
          await fixture.close();
        }
        // Import checkpoints live on the destination, not in checkpoint.json. A valid
        // export checkpoint is retained byte-for-byte and is not destination authority.
        const checkpoint = JSON.stringify({
          fingerprint: 'a'.repeat(64),
          sourceIdentity: 'synthetic-source',
          keys: {},
          nextKey: 0,
          exported_at: manifest.exported_at,
        });
        await writeFile(join(directory, 'checkpoint.json'), checkpoint);
        // Stored-login/JWT path, as well as the direct bearer path below.
        const rest = await createRestClient(server.url);
        await rest.authenticate({
          strategy: 'jwt',
          accessToken: server.headers(owner.user_id).authorization.slice(7),
        });
        const client = knowledgeTransferClient(rest);
        const { rawKey } = await new UserApiKeysRepository(db).create(
          owner.user_id,
          'Synthetic CLI',
          'cli_login'
        );
        const apiKeyClient = knowledgeTransferClient(await createRestClient(server.url, rawKey));
        // CLI login uses a personal API key, not a JWT used as a bearer. The
        // auth entity lookup must not mutate the transfer's query object.
        expect(
          await importKnowledge(apiKeyClient, { ...options, resume: true }, progress)
        ).toMatchObject({ dryRun: true, pending: 101 });
        const smallDirectory = join(directory, 'small');
        await mkdir(smallDirectory, { mode: 0o700 });
        const smallManifest = { ...manifest, documents: manifest.documents.slice(0, 2) };
        await writeRepositoryFixture(smallDirectory, smallManifest, content);
        const smallOptions = { ...options, directory: smallDirectory, namespace: 'api-key-target' };
        for (const resume of [false, true]) {
          expect(
            await importKnowledge(apiKeyClient, { ...smallOptions, resume }, progress)
          ).toMatchObject({ dryRun: true, pending: 2 });
          expect(
            await new KnowledgeNamespaceRepository(db).findBySlug(smallOptions.namespace)
          ).toBeNull();
        }
        expect(
          await importKnowledge(apiKeyClient, { ...smallOptions, dryRun: false }, progress)
        ).toMatchObject({ created: 2 });
        expect(
          await importKnowledge(
            apiKeyClient,
            { ...smallOptions, dryRun: false, resume: true },
            progress
          )
        ).toMatchObject({ created: 0, unchanged: 2 });
        const bundle = transferDigest(manifest);
        for (const resume of [false, true]) {
          expect(await importKnowledge(client, { ...options, resume }, progress)).toMatchObject({
            pending: 101,
            dryRun: true,
          });
          expect(
            await new KnowledgeNamespaceRepository(db).findBySlug(options.namespace)
          ).toBeNull();
        }
        // Same-bundle partial progress, including a lost document acknowledgement.
        await client.create({
          action: 'namespace',
          bundle,
          slug: options.namespace,
          display_name: 'Synthetic',
          description: null,
          resume: false,
        });
        expect(
          await client.find({ query: { namespace: options.namespace, bundle } })
        ).toMatchObject({
          total: 0,
          receipts: [],
          next_cursor: null,
          namespace: { slug: options.namespace },
        });
        const first = await client.create({
          action: 'document',
          bundle,
          slug: options.namespace,
          entry: manifest.documents[0],
          content,
        });
        expect(await importKnowledge(client, { ...options, resume: true }, progress)).toMatchObject(
          { unchanged: 1, pending: 100 }
        );
        await expect(importKnowledge(client, options, progress)).rejects.toThrow('use --resume');
        expect(
          await importKnowledge(client, { ...options, dryRun: false, resume: true }, progress)
        ).toMatchObject({ created: 100, unchanged: 1 });
        const page = await client.find({ query: { namespace: options.namespace, bundle } });
        expect(page.receipts).toHaveLength(100);
        expect(page.total).toBe(101);
        expect(page.next_cursor).toBe('d000100');
        expect(
          await apiKeyClient.find({
            query: { namespace: options.namespace, bundle, cursor: page.next_cursor },
          })
        ).toMatchObject({
          receipts: [{ key: 'd000101' }],
          total: 101,
          next_cursor: null,
        });
        await expect(
          apiKeyClient.find({
            query: { namespace: options.namespace, bundle, tenant_id: 'foreign' },
          })
        ).rejects.toMatchObject({
          code: 400,
          data: {
            issues: [expect.objectContaining({ path: ['tenant_id'], code: 'unrecognized_keys' })],
          },
        });
        expect(
          await client.find({
            query: { namespace: options.namespace, bundle, cursor: page.next_cursor },
          })
        ).toMatchObject({
          receipts: [{ key: 'd000101' }],
          total: 101,
          next_cursor: null,
        });
        expect(
          await importKnowledge(client, { ...options, dryRun: false, resume: true }, progress)
        ).toMatchObject({ created: 0, unchanged: 101 });
        expect(
          await new KnowledgeDocumentVersionRepository(db).findAll({
            document_id: first.target_id as KnowledgeDocumentID,
          })
        ).toHaveLength(1);
        expect(await readFile(join(directory, 'checkpoint.json'), 'utf8')).toBe(checkpoint);
        expect(
          await importKnowledge(
            client,
            { ...options, namespace: 'fresh-target', dryRun: false },
            progress
          )
        ).toMatchObject({ created: 101 });
        await expect(
          client.find({ query: { namespace: options.namespace, bundle: 'b'.repeat(64) } })
        ).rejects.toMatchObject({ code: 409 });
        const other = knowledgeTransferClient(
          await createRestClient(
            server.url,
            server.headers(stranger.user_id).authorization.slice(7)
          )
        );
        await expect(
          other.find({ query: { namespace: options.namespace, bundle } })
        ).rejects.toMatchObject({ code: 409 });
        await expect(
          client.find({ query: { namespace: options.namespace } })
        ).rejects.toMatchObject({ code: 403 });
        const anonymous = knowledgeTransferClient(await createRestClient(server.url));
        await expect(
          anonymous.find({ query: { namespace: options.namespace, bundle } })
        ).rejects.toMatchObject({ code: 401 });
        for (const extra of [
          { $limit: 100 },
          { $skip: 0 },
          { tenant_id: 'foreign' },
          { cursor: 'x'.repeat(101) },
        ]) {
          await expect(
            client.find({ query: { namespace: options.namespace, bundle, ...extra } })
          ).rejects.toMatchObject({
            code: 400,
            message: expect.stringContaining(
              'Invalid Knowledge transfer request (GET /kb/transfers)'
            ),
          });
        }
        const invalidNamespace = {
          action: 'namespace',
          bundle,
          slug: 'invalid-request',
          display_name: 'Private fixture title',
          description: null,
          'private-key-do-not-log': 'private-value-do-not-log',
        };
        // An old CLI missing resume is still rejected, not silently defaulted
        // server-side. Even old clients printing only .message get safe fields.
        const rejected = await fetch(`${server.url}/${KNOWLEDGE_TRANSFER.path}`, {
          method: 'POST',
          headers: server.headers(owner.user_id),
          body: JSON.stringify(invalidNamespace),
        });
        expect(rejected.status).toBe(400);
        const diagnostic = await rejected.json();
        expect(diagnostic).toMatchObject({
          message: expect.stringContaining('POST /kb/transfers'),
        });
        expect(diagnostic).toMatchObject({
          message: expect.stringContaining('resume: Missing field or wrong type'),
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(
          /Private fixture title|private-key-do-not-log|private-value-do-not-log/
        );
        expect(await new KnowledgeNamespaceRepository(db).findBySlug('invalid-request')).toBeNull();
        await new KnowledgeDocumentRepository(db).update(first.target_id, { title: 'Edited' });
        await expect(
          importKnowledge(client, { ...options, dryRun: false, resume: true }, progress)
        ).rejects.toThrow('conflict');
        expect(lines.join('')).not.toContain(content);
      } finally {
        progress.close();
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );
});
