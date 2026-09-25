import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_TRANSFER, type KnowledgeTransferManifest } from '../types/knowledge-transfer';
import {
  serializeTransferManifest,
  transferCanonical,
  transferDigest,
  transferSha256,
  validateTransferManifest,
} from './transfer';
import { rewriteTransferLinks } from './transfer-links';

const id = '12345678-1234-1234-1234-123456789012';
function manifest(): KnowledgeTransferManifest {
  return {
    format: 'agor-knowledge-namespace',
    version: 1,
    completed: true,
    exported_at: '2026-09-22T12:00:00Z',
    consistency: 'per-document-version; non-atomic-inventory',
    namespace: { slug: 'source', display_name: 'Source', description: null, provenance: {} },
    omissions: ['history'],
    documents: [
      {
        key: 'd000001',
        path: 'a space.md',
        title: 'A',
        icon_emoji: null,
        kind: 'doc',
        status: 'draft',
        sha256: transferSha256(''),
        bytes: 0,
        frontmatter: null,
        provenance: { source_uuid: id },
      },
    ],
  };
}
describe('Knowledge portable format', () => {
  it('publishes the exact bounded serialization rather than oversized pretty JSON', () => {
    const value = manifest();
    value.namespace.provenance = { padding: '' };
    const overhead = Buffer.byteLength(serializeTransferManifest(value));
    value.namespace.provenance.padding = 'x'.repeat(KNOWLEDGE_TRANSFER.maxManifestBytes - overhead);
    const serialized = serializeTransferManifest(value);
    expect(Buffer.byteLength(serialized)).toBe(KNOWLEDGE_TRANSFER.maxManifestBytes);
    expect(Buffer.byteLength(JSON.stringify(value, null, 2))).toBeGreaterThan(
      KNOWLEDGE_TRANSFER.maxManifestBytes
    );
    expect(validateTransferManifest(JSON.parse(serialized))).toEqual(value);
    value.namespace.provenance.padding += 'x';
    expect(() => serializeTransferManifest(value)).toThrow('Manifest is too large');
  });

  it('validates digests, exact UTF-8, uniqueness, paths and JSON depth', () => {
    expect(validateTransferManifest(manifest()).documents).toHaveLength(1);
    expect(transferSha256('café\r\n')).not.toBe(transferSha256('café\n'));
    expect(transferDigest({ b: 2, a: 1 })).toBe(transferDigest({ a: 1, b: 2 }));
    const duplicate = manifest();
    duplicate.documents.push(duplicate.documents[0]);
    expect(() => validateTransferManifest(duplicate)).toThrow('Duplicate');
    const bad = manifest();
    bad.documents[0].path = '../outside';
    expect(() => validateTransferManifest(bad)).toThrow();
    let deep: unknown = null;
    for (let i = 0; i < 23; i++) deep = { deep };
    expect(() => transferCanonical(deep)).toThrow('depth');
    expect(() => validateTransferManifest({ ...manifest(), completed: false })).toThrow();
  });
  it('rewrites parsed links and definitions, not prose/code, and preserves fragments', () => {
    const uri = `agor://kb/document/${id}`;
    const source = `[a](${uri}#intro)\n\n[x]: agor://kb/source/a%20space.md\n\n\`${uri}\`\n\n\`\`\`md\n[a](${uri})\n\`\`\`\n\n[other](agor://kb/other/missing.md)`;
    const result = rewriteTransferLinks(source, manifest(), 'destination');
    expect(result.content).toContain('[a](agor://kb/destination/a%20space.md#intro)');
    expect(result.content).toContain('[x]: agor://kb/destination/a%20space.md');
    expect(result.content).toContain(`\`${uri}\``);
    expect(result.content).toContain(`[a](${uri})\n\`\`\``);
    expect(result.unresolved).toBe(1);
  });
});
