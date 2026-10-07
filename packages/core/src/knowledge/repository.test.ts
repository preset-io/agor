import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_REPOSITORY, type KnowledgeRepositoryHeader } from '../types/knowledge-transfer';
import {
  decodeKnowledgeDocument,
  encodeKnowledgeDocument,
  exportRepositoryLinks,
  importRepositoryLinks,
  knowledgeRepositoryFiles,
  parseKnowledgeYaml,
  repositoryTransferManifest,
  serializeKnowledgeYaml,
  validateRepositoryManifest,
} from './repository';
import { transferDigest } from './transfer';

const header: KnowledgeRepositoryHeader = {
  format: KNOWLEDGE_REPOSITORY.documentFormat,
  version: 2,
  agor: {
    id: '00000000-0000-4000-8000-000000000001',
    path: 'guide',
    title: 'Guide',
    kind: 'doc',
    status: 'draft',
    icon_emoji: null,
  },
  frontmatter: { agor: 'user data', date: '2026-10-06' },
  provenance: { source_uuid: '00000000-0000-4000-8000-000000000001' },
};
const index = {
  format: 'agor-knowledge-namespace',
  version: 2,
  namespace: { slug: 'source', display_name: 'Source', description: null, provenance: {} },
  documents: ['docs/guide.md'],
  omissions: [],
};

describe('Knowledge repository v2', () => {
  it('preserves existing body frontmatter, prose metadata, Unicode and exact newlines', () => {
    const body = '\uFEFF---\r\ncustom: unchanged\r\n---\r\n# Café\r\nDate · Reporter\r\n';
    const text = encodeKnowledgeDocument(header, body);
    expect(decodeKnowledgeDocument(text)).toEqual({ header, body });
    expect(serializeKnowledgeYaml(header)).toBe(
      serializeKnowledgeYaml({ ...header, provenance: { source_uuid: header.agor.id } })
    );
    const manifest = validateRepositoryManifest(index);
    const a = repositoryTransferManifest(manifest, [decodeKnowledgeDocument(text)]);
    const b = repositoryTransferManifest(manifest, [
      decodeKnowledgeDocument(text.replace('version: 2', 'version:  2')),
    ]);
    expect(transferDigest(a)).toBe(transferDigest(b));
  });
  it.each([
    'a: 1\na: 2',
    'a: &x [one]\nb: *x',
    'a: !!js/function function(){}',
    'a: !!str yes',
    'a: {<<: {b: 1}}',
    '---\na: 1\n---\nb: 2',
    `x: ${'['.repeat(60)}0${']'.repeat(60)}`,
  ])('rejects unsafe YAML without echoing it', (text) => {
    expect(() => parseKnowledgeYaml(text)).toThrow('Invalid Knowledge YAML');
    try {
      parseKnowledgeYaml(text);
    } catch (error) {
      expect((error as Error).message).not.toContain(text);
    }
  });
  it('maps portable trees deterministically, not titles or truncated UUIDs', () => {
    const paths = [
      'guide',
      'guide.md',
      'Guide.md',
      'guide.md/child.md',
      'Foo/a.md',
      'foo/b.md',
      'café.md',
      'cafe\u0301.md',
      '.git/config',
      `${'é'.repeat(150)}.md`,
      'simple/hello.md',
    ];
    const files = knowledgeRepositoryFiles(paths);
    expect(files.get('simple/hello.md')).toBe('docs/simple/hello.md');
    expect([...files.values()].some((file) => file.includes('/.git/'))).toBe(false);
    expect(knowledgeRepositoryFiles([...paths].reverse())).toEqual(files);
    expect(() =>
      validateRepositoryManifest({ ...index, documents: [...files.values()] })
    ).not.toThrow();
    expect(
      new Set([...files.values()].map((file) => file.normalize('NFC').toLowerCase())).size
    ).toBe(paths.length);
  });
  it('preserves established names when new paths introduce a collision', () => {
    const previous = knowledgeRepositoryFiles(['Foo/a.md', 'guide']);
    const refreshed = knowledgeRepositoryFiles(
      ['Foo/a.md', 'foo/b.md', 'guide', 'guide.md'],
      previous
    );
    expect(refreshed.get('Foo/a.md')).toBe(previous.get('Foo/a.md'));
    expect(refreshed.get('guide')).toBe(previous.get('guide'));
    expect(() =>
      validateRepositoryManifest({ ...index, documents: [...refreshed.values()] })
    ).not.toThrow();
  });
  it.each([
    ['docs/A.md', 'docs/a.md'],
    ['docs/Foo/a.md', 'docs/foo/b.md'],
    ['docs/a.md', 'docs/a.md/b.md'],
    ['docs/.git/config.md'],
    ['docs/../secret.md'],
  ])('rejects conflicting/unsafe user indexes %s', (...documents) => {
    expect(() => validateRepositoryManifest({ ...index, documents })).toThrow();
  });
  it('rewrites relative links bidirectionally while preserving code and fragments', () => {
    const manifest = repositoryTransferManifest(validateRepositoryManifest(index), [
      { header, body: '' },
    ]);
    const files = new Map([['guide', 'docs/guides/guide.md']]);
    const body = `[link](agor://kb/document/${header.agor.id}#intro)\n\n[ref]: agor://kb/source/guide\n\n\`agor://kb/source/guide\``;
    const exported = exportRepositoryLinks(body, manifest, files, 'docs/other/readme.md');
    expect(exported.content).toContain('../guides/guide.md#intro');
    expect(exported.content).toContain('`agor://kb/source/guide`');
    const imported = importRepositoryLinks(
      exported.content,
      'docs/other/readme.md',
      new Map([['docs/guides/guide.md', 'guide']]),
      'target'
    );
    expect(imported.content).toContain('agor://kb/target/guide#intro');
    expect(imported.content).toContain('[ref]: agor://kb/target/guide');
    const autolink = exportRepositoryLinks(
      `<agor://kb/source/guide>`,
      manifest,
      files,
      'docs/a.md'
    );
    expect(autolink.content).toBe('[agor://kb/source/guide](<guides/guide.md>)');
    expect(
      importRepositoryLinks('[x](../../../secret.md)', 'docs/a.md', new Map(), 'target').unresolved
    ).toBe(1);
  });
});
