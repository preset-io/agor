import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseKnowledgeYaml,
  transferDigest,
  transferSha256,
  validateRepositoryManifest,
} from '@agor/core/knowledge';
import type { KnowledgeTransferInventoryEntry, KnowledgeTransferPage } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeValidate from '../../commands/kb/validate';
import { KnowledgeProgress } from './progress';
import { loadKnowledgeRepository, validateKnowledgeRepository } from './repository';
import { RepositoryDirectory } from './repository-directory';
import { exportKnowledge } from './repository-export';
import { importKnowledge, type knowledgeTransferClient } from './transfer';

describe.skipIf(process.platform === 'win32')('editable Knowledge repository', () => {
  let root: string;
  let progress: KnowledgeProgress;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kb-v2-'));
    progress = new KnowledgeProgress({ isTTY: false, write: () => true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    progress.close();
    await rm(root, { recursive: true, force: true });
  });

  function fixture() {
    const contents = new Map([
      ['nested/a.md', '# A\r\n[other](agor://kb/source/b)\r\n'],
      ['b', '# B\nDate · Reporter\n'],
    ]);
    const entries: KnowledgeTransferInventoryEntry[] = [...contents].map(
      ([path, content], index) => ({
        document_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        version_id: '00000000-0000-4000-8000-000000000099',
        path,
        title: path,
        icon_emoji: null,
        kind: 'doc',
        status: 'published',
        sha256: transferSha256(content),
        bytes: Buffer.byteLength(content),
        mime_type: 'text/markdown',
        frontmatter: { tags: ['synthetic'] },
        provenance: {
          source_uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        },
      })
    );
    const page: KnowledgeTransferPage = {
      namespace: { slug: 'source', display_name: 'Source', description: null, provenance: {} },
      entries,
      receipts: [],
      total: entries.length,
      next_cursor: null,
    };
    const client: ReturnType<typeof knowledgeTransferClient> = {
      find: vi.fn(async () => page),
      get: vi.fn(async (id) => {
        const entry = entries.find((row) => row.document_id === id)!;
        const content = contents.get(entry.path)!;
        return { content, sha256: transferSha256(content), bytes: Buffer.byteLength(content) };
      }),
      create: vi.fn(async () => {
        throw new Error('No destination writes expected');
      }),
    };
    const options = {
      namespace: 'source',
      directory: join(root, 'repo'),
      dryRun: false,
      resume: false,
      sourceIdentity: 'synthetic-source',
      signal: new AbortController().signal,
    };
    return { client, options, entries, contents, page };
  }

  it('exports a stable readable tree, supports edited clones and does not change authored metadata prose', async () => {
    const { client, options } = fixture();
    await exportKnowledge(client, options, progress);
    const first = await readFile(join(options.directory, 'manifest.yaml'), 'utf8');
    const file = join(options.directory, 'docs/nested/a.md');
    const time = (await stat(file)).mtimeMs;
    expect(await readFile(file, 'utf8')).toContain('[other](../b.md)\r\n');
    expect(await readFile(join(options.directory, 'docs/b.md'), 'utf8')).toContain(
      'Date · Reporter\n'
    );
    await exportKnowledge(client, { ...options, resume: true }, progress);
    expect(await readFile(join(options.directory, 'manifest.yaml'), 'utf8')).toBe(first);
    expect((await stat(file)).mtimeMs).toBe(time);
    expect(await validateKnowledgeRepository(options.directory)).toMatchObject({
      valid: true,
      documents: 2,
      unresolved: 0,
    });
    const clone = join(root, 'clone');
    await mkdir(clone);
    await chmod(clone, 0o755);
    await cp(join(options.directory, 'docs'), join(clone, 'docs'), { recursive: true });
    await writeFile(join(clone, 'manifest.yaml'), first);
    const before = await validateKnowledgeRepository(clone);
    const editable = join(clone, 'docs/nested/a.md');
    await writeFile(
      editable,
      (await readFile(editable, 'utf8')).replace('# A\r\n', '# Edited\r\n')
    );
    const after = await validateKnowledgeRepository(clone);
    expect(after.bundle).not.toBe(before.bundle);
    const directory = await RepositoryDirectory.open(clone);
    try {
      const loaded = await loadKnowledgeRepository(directory, 'destination');
      expect(loaded.unresolved).toBe(0);
      expect([...loaded.contentByKey.values()].join('')).toContain(
        '[other](agor://kb/destination/b)'
      );
      expect([...loaded.contentByKey.values()].join('')).toContain('# Edited\r\n');
      await writeFile(editable, `${await readFile(editable, 'utf8')}another edit`);
      await expect(loaded.verify()).rejects.toThrow('changed after planning');
    } finally {
      await directory.close();
    }
    await expect(
      exportKnowledge(client, { ...options, directory: clone }, progress)
    ).rejects.toThrow('private');
  });

  it('detects local edits before source requests and retains removed source files without importing them', async () => {
    const { client, options, page } = fixture();
    await exportKnowledge(client, options, progress);
    const edited = join(options.directory, 'docs/nested/a.md');
    const original = await readFile(edited, 'utf8');
    await writeFile(edited, `${original}local edit`);
    vi.mocked(client.find).mockClear();
    await expect(exportKnowledge(client, options, progress)).rejects.toThrow(
      'Local content differs'
    );
    expect(client.find).not.toHaveBeenCalled();
    await writeFile(edited, original);
    page.entries = page.entries.slice(1);
    page.total = 1;
    const result = await exportKnowledge(client, { ...options, resume: true }, progress);
    expect(result).toMatchObject({ retained: ['docs/nested/a.md'] });
    expect(await readFile(edited, 'utf8')).toBe(original);
    expect(await validateKnowledgeRepository(options.directory)).toMatchObject({
      documents: 1,
      unlisted: ['docs/nested/a.md'],
    });
  });

  it.each([false, true])(
    'journals interrupted publication and refuses intervening edits (%s)',
    async (edited) => {
      const { client, options } = fixture();
      const write = RepositoryDirectory.prototype.write;
      let documents = 0;
      const interruption = vi
        .spyOn(RepositoryDirectory.prototype, 'write')
        .mockImplementation(async function (this: RepositoryDirectory, name, text) {
          if (name.startsWith('docs/') && ++documents === 2)
            throw new Error('Synthetic interruption');
          return write.call(this, name, text);
        });
      await expect(exportKnowledge(client, options, progress)).rejects.toThrow(
        'Synthetic interruption'
      );
      interruption.mockRestore();
      await expect(validateKnowledgeRepository(options.directory)).rejects.toThrow(
        'publication incomplete'
      );
      const pending = JSON.parse(
        await readFile(join(options.directory, '.agor/pending.json'), 'utf8')
      );
      if (edited) {
        const written = pending.writes.find((entry: { file: string }) =>
          entry.file.startsWith('docs/')
        );
        const path = join(options.directory, written.file);
        await writeFile(path, 'independent edit');
        await expect(
          exportKnowledge(client, { ...options, resume: true }, progress)
        ).rejects.toThrow('refusing overwrite');
        expect(await readFile(path, 'utf8')).toBe('independent edit');
      } else {
        await expect(
          exportKnowledge(
            client,
            { ...options, resume: true, sourceIdentity: 'another-source' },
            progress
          )
        ).rejects.toThrow('another deployment');
        await exportKnowledge(client, { ...options, resume: true }, progress);
        expect(await validateKnowledgeRepository(options.directory)).toMatchObject({
          documents: 2,
        });
        expect(await readFile(join(options.directory, '.agor/pending.json'), 'utf8')).toBe('null');
      }
    }
  );

  it('refuses v1, missing/invalid headers, missing indexed files and invalid YAML without daemon calls', async () => {
    const { client, options } = fixture();
    await mkdir(options.directory, { mode: 0o700 });
    await writeFile(join(options.directory, 'manifest.json'), '{"version":1}');
    await expect(importKnowledge(client, options, progress)).rejects.toThrow(
      'Unsupported Knowledge export version 1'
    );
    expect(client.find).not.toHaveBeenCalled();
    await rm(join(options.directory, 'manifest.json'));
    await exportKnowledge(client, options, progress);
    await rm(join(options.directory, 'docs/b.md'));
    vi.mocked(client.find).mockClear();
    await expect(importKnowledge(client, options, progress)).rejects.toThrow('Missing indexed');
    expect(client.find).not.toHaveBeenCalled();
    await writeFile(join(options.directory, 'docs/b.md'), 'no header');
    await expect(validateKnowledgeRepository(options.directory)).rejects.toThrow('YAML header');
    await writeFile(
      join(options.directory, 'manifest.yaml'),
      'secret: !!js/function private-source-code'
    );
    await expect(validateKnowledgeRepository(options.directory)).rejects.toThrow(
      'Invalid Knowledge YAML'
    );
  });

  it('normalizes YAML formatting/order for import identity and handles an empty namespace', async () => {
    const { client, options, page } = fixture();
    page.entries = [];
    page.total = 0;
    await exportKnowledge(client, options, progress);
    const first = await validateKnowledgeRepository(options.directory);
    const path = join(options.directory, 'manifest.yaml');
    const text = await readFile(path, 'utf8');
    await writeFile(path, `# A harmless comment\n${text.replace('version: 2', 'version:    2')}`);
    expect((await validateKnowledgeRepository(options.directory)).bundle).toBe(first.bundle);
    expect(first.documents).toBe(0);
    expect(transferDigest(validateRepositoryManifest(parseKnowledgeYaml(text)))).toBeTruthy();
  });

  it('rejects symlinked ancestors, hardlinked files and swapped directory identities', async () => {
    const { client, options } = fixture();
    await exportKnowledge(client, options, progress);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'a.md'), 'outside secret');
    await rm(join(options.directory, 'docs/nested'), { recursive: true });
    await symlink(outside, join(options.directory, 'docs/nested'));
    await expect(validateKnowledgeRepository(options.directory)).rejects.toThrow();
    await rm(join(options.directory, 'docs/nested'));
    await mkdir(join(options.directory, 'docs/nested'), { mode: 0o700 });
    await link(join(outside, 'a.md'), join(options.directory, 'docs/nested/a.md'));
    await expect(validateKnowledgeRepository(options.directory)).rejects.toThrow('Unsafe');
    const directory = await RepositoryDirectory.open(options.directory);
    try {
      await expect(
        directory.withDirectory('docs/nested', false, async () => {
          await rename(join(options.directory, 'docs/nested'), join(root, 'moved'));
          await symlink(outside, join(options.directory, 'docs/nested'));
        })
      ).rejects.toThrow();
    } finally {
      await directory.close();
    }
    expect(await readFile(join(outside, 'a.md'), 'utf8')).toBe('outside secret');
  });

  it('does not recreate a local file deleted while fetching a refreshed source', async () => {
    const { client, options, entries, contents } = fixture();
    await exportKnowledge(client, options, progress);
    const file = join(options.directory, 'docs/nested/a.md');
    const before = await readFile(join(options.directory, 'manifest.yaml'), 'utf8');
    const updated = '# Updated source\n';
    contents.set(entries[0].path, updated);
    entries[0].sha256 = transferSha256(updated);
    entries[0].bytes = Buffer.byteLength(updated);
    const get = client.get;
    client.get = async (id, params) => {
      const result = await get(id, params);
      await rm(file);
      return result;
    };
    await expect(exportKnowledge(client, { ...options, resume: true }, progress)).rejects.toThrow(
      'refusing overwrite'
    );
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(options.directory, 'manifest.yaml'), 'utf8')).toBe(before);
  });

  it('rechecks expected content immediately before a replacement and refuses unsafe state ancestors', async () => {
    const { client, options } = fixture();
    const directory = await RepositoryDirectory.open(options.directory, true);
    try {
      await directory.lock();
      await directory.write('docs/test.md', 'original');
      await writeFile(join(options.directory, 'docs/test.md'), 'local edit');
      await expect(
        directory.write('docs/test.md', 'replacement', transferSha256('original'))
      ).rejects.toThrow('refusing overwrite');
      expect(await readFile(join(options.directory, 'docs/test.md'), 'utf8')).toBe('local edit');
    } finally {
      await directory.close();
    }
    const outside = join(root, 'state-outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(options.directory, '.agor'));
    await expect(exportKnowledge(client, options, progress)).rejects.toThrow();
    expect(client.find).not.toHaveBeenCalled();
  });

  it('runs the offline command without a daemon, login or file changes', async () => {
    const { client, options } = fixture();
    await exportKnowledge(client, options, progress);
    const commandRoot = join(root, 'command');
    await mkdir(commandRoot);
    // An isolated oclif config, without the unbuilt checkout's dist hooks.
    await writeFile(
      join(commandRoot, 'package.json'),
      JSON.stringify({ name: 'synthetic-offline-cli', version: '0.0.0', oclif: { bin: 'agor' } })
    );
    const before = await readFile(join(options.directory, 'manifest.yaml'), 'utf8');
    const output: string[] = [];
    vi.spyOn(KnowledgeValidate.prototype, 'log').mockImplementation((message) => {
      output.push(String(message));
    });
    const network = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network allowed'));
    await KnowledgeValidate.run([options.directory], { root: commandRoot });
    expect(JSON.parse(output[0])).toMatchObject({ valid: true, documents: 2, version: 2 });
    expect(network).not.toHaveBeenCalled();
    expect(await readFile(join(options.directory, 'manifest.yaml'), 'utf8')).toBe(before);
  });

  it('refuses empty continuation pages instead of endlessly retrying destination inventory', async () => {
    const { client, options, page } = fixture();
    await exportKnowledge(client, options, progress);
    client.find = vi.fn(async () => ({
      ...page,
      namespace: null,
      entries: [],
      receipts: [],
      next_cursor: 'loop',
    }));
    await expect(
      importKnowledge(client, { ...options, dryRun: true, namespace: 'target' }, progress)
    ).rejects.toThrow('pagination');
    expect(client.find).toHaveBeenCalledTimes(1);
    expect(client.create).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 503])(
    'stops export immediately on systemic HTTP %s failures',
    async (code) => {
      const { client, options } = fixture();
      vi.mocked(client.get).mockRejectedValue(
        Object.assign(new Error('private response'), { code })
      );
      await expect(exportKnowledge(client, options, progress)).rejects.toThrow(`HTTP ${code}`);
      expect(client.get).toHaveBeenCalledTimes(1);
      await expect(readFile(join(options.directory, 'manifest.yaml'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('caches independent documents after checksum and per-document preflight failures', async () => {
    const { client, options, entries } = fixture();
    client.get = vi.fn(async (id) => {
      const content =
        id === entries[0].document_id
          ? '# A\r\n[other](agor://kb/source/b)\r\n'
          : '# B\nDate · Reporter\n';
      return {
        content,
        bytes: Buffer.byteLength(content),
        sha256: id === entries[0].document_id ? '0'.repeat(64) : transferSha256(content),
      };
    });
    await expect(exportKnowledge(client, options, progress)).rejects.toThrow(
      'Source checksum mismatch'
    );
    expect(client.get).toHaveBeenCalledTimes(2);
    await expect(readFile(join(options.directory, 'manifest.yaml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const second = fixture();
    second.options.directory = join(root, 'unsupported');
    second.entries[0].mime_type = 'application/octet-stream';
    await expect(exportKnowledge(second.client, second.options, progress)).rejects.toThrow(
      '1 bodies cached; 0 unchanged; 1 failed'
    );
    expect(second.client.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(second.client.get).mock.calls[0][0]).toBe(second.entries[1].document_id);
  });

  it.each([400, 401, 403, 429, 503])(
    'stops import immediately on systemic HTTP %s failures',
    async (code) => {
      const { client, options } = fixture();
      await exportKnowledge(client, options, progress);
      client.find = vi.fn(async () => ({
        namespace: null,
        entries: [],
        receipts: [],
        total: 0,
        next_cursor: null,
      }));
      client.create = vi.fn(async (data) => {
        if (data.action !== 'namespace')
          throw Object.assign(new Error('private response'), { code });
        return { target_id: '00000000-0000-4000-8000-000000000099', skipped: false };
      });
      await expect(
        importKnowledge(client, { ...options, namespace: 'target' }, progress)
      ).rejects.toThrow(`HTTP ${code}`);
      expect(client.create).toHaveBeenCalledTimes(2);
    }
  );

  it('leaves the previous readable snapshot unchanged when a refresh only partially succeeds', async () => {
    const { client, options, entries, contents } = fixture();
    await exportKnowledge(client, options, progress);
    const manifest = await readFile(join(options.directory, 'manifest.yaml'), 'utf8');
    const previous = await readFile(join(options.directory, 'docs/b.md'), 'utf8');
    for (const entry of entries) {
      const content = `${contents.get(entry.path)!}new source version`;
      contents.set(entry.path, content);
      entry.sha256 = transferSha256(content);
      entry.bytes = Buffer.byteLength(content);
      entry.version_id = '00000000-0000-4000-8000-000000000100';
    }
    const normalGet = vi.mocked(client.get).getMockImplementation()!;
    vi.mocked(client.get)
      .mockImplementation(async (id, params) => {
        if (id === entries[0].document_id)
          throw Object.assign(new Error('private failure'), { code: 500 });
        return normalGet(id, params);
      })
      .mockClear();
    await expect(exportKnowledge(client, { ...options, resume: true }, progress)).rejects.toThrow(
      '1 bodies cached; 0 unchanged; 1 failed'
    );
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(await readFile(join(options.directory, 'manifest.yaml'), 'utf8')).toBe(manifest);
    expect(await readFile(join(options.directory, 'docs/b.md'), 'utf8')).toBe(previous);
    await expect(validateKnowledgeRepository(options.directory)).resolves.toMatchObject({
      valid: true,
    });
    vi.mocked(client.get).mockImplementation(normalGet).mockClear();
    await expect(
      exportKnowledge(client, { ...options, resume: true }, progress)
    ).resolves.toMatchObject({ copied: 1, unchanged: 1 });
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('stops on empty source continuation pages before fetching any bodies', async () => {
    const { client, options, page } = fixture();
    client.find = vi.fn(async () => ({ ...page, entries: [], next_cursor: 'loop' }));
    await expect(exportKnowledge(client, options, progress)).rejects.toThrow(
      'source inventory pagination'
    );
    expect(client.find).toHaveBeenCalledTimes(1);
    expect(client.get).not.toHaveBeenCalled();
  });
  it('counts only original unresolved links when importing into a different namespace', async () => {
    const { client, options } = fixture();
    await exportKnowledge(client, options, progress);
    const file = join(options.directory, 'docs/nested/a.md');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}\n[source](agor://kb/source/b)\n[missing](missing.md)\n[foreign](agor://kb/another/b)\n`
    );
    const directory = await RepositoryDirectory.open(options.directory);
    try {
      const loaded = await loadKnowledgeRepository(directory, 'destination');
      expect(loaded.unresolved).toBe(2);
      const content = [...loaded.contentByKey.values()].join('\n');
      expect(content).toContain('[other](agor://kb/destination/b)');
      expect(content).toContain('[source](agor://kb/destination/b)');
      expect(content).toContain('[missing](missing.md)');
      expect(content).toContain('[foreign](agor://kb/another/b)');
    } finally {
      await directory.close();
    }
  });
});
