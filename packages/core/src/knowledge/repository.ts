import { posix } from 'node:path';
import { dump, JSON_SCHEMA, load } from 'js-yaml';
import { normalizeKnowledgePath } from '../types/knowledge.js';
import {
  KNOWLEDGE_REPOSITORY,
  KNOWLEDGE_TRANSFER,
  type KnowledgeRepositoryHeader,
  type KnowledgeRepositoryManifest,
  type KnowledgeTransferManifest,
  knowledgeRepositoryHeaderSchema,
  knowledgeRepositoryManifestSchema,
} from '../types/knowledge-transfer.js';
import { transferCanonical, transferSha256 } from './transfer.js';
import { encodeMarkdownUrlSegment, rewriteKnowledgeLinks } from './transfer-links.js';

/** Parse bounded, non-executable YAML. Never expose parser snippets/private values. */
export function parseKnowledgeYaml(text: string): unknown {
  if (Buffer.byteLength(text) > KNOWLEDGE_TRANSFER.maxManifestBytes)
    throw new Error('Knowledge YAML exceeds the metadata byte limit');
  let depth = 0;
  let nodes = 0;
  try {
    const value = load(text, {
      schema: JSON_SCHEMA,
      listener: (event, state) => {
        if (event === 'open') {
          if (/^(?:\s|#[^\n]*\n)*[!&*]/.test(state.input.slice(state.position)))
            throw new Error('YAML tags/anchors/aliases are not supported');
          if (++depth > 45 || ++nodes > 200_000) throw new Error('YAML nesting/node limit');
        } else {
          depth--;
          if ('anchor' in state && state.anchor) throw new Error('YAML anchors are not supported');
        }
      },
    });
    const visit = (v: unknown): void => {
      if (v && typeof v === 'object') {
        if (Object.hasOwn(v, '<<')) throw new Error('YAML merge keys are not supported');
        for (const child of Object.values(v)) visit(child);
      }
    };
    // Canonicalization bounds depth and rejects non-JSON values before traversal.
    transferCanonical(value);
    visit(value);
    return value;
  } catch {
    throw new Error(
      'Invalid Knowledge YAML: use unique keys and bounded JSON values; aliases, tags and merge keys are not supported'
    );
  }
}

export function serializeKnowledgeYaml(value: unknown): string {
  // Stable recursive key ordering; no timestamps, aliases or locale-sensitive sorts.
  const text = dump(JSON.parse(transferCanonical(value)), {
    schema: JSON_SCHEMA,
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: true,
    forceQuotes: false,
  });
  if (Buffer.byteLength(text) > KNOWLEDGE_TRANSFER.maxManifestBytes)
    throw new Error('Knowledge YAML exceeds the metadata byte limit');
  return text;
}

export function portableKnowledgeFile(file: string): string {
  if (normalizeKnowledgePath(file) !== file || !file.startsWith('docs/') || !file.endsWith('.md'))
    throw new Error('Repository document filenames must be canonical docs/**/*.md paths');
  for (const part of file.split('/')) {
    if (part.startsWith('.') || part !== part.normalize('NFC') || Buffer.byteLength(part) > 240)
      throw new Error('Unsafe or non-portable repository path component');
  }
  if (Buffer.byteLength(file) > 2048) throw new Error('Repository path is too long');
  return file;
}

const folded = (path: string) => path.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD');
export function validateRepositoryManifest(value: unknown): KnowledgeRepositoryManifest {
  const result = knowledgeRepositoryManifestSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      'Invalid manifest.yaml: expected Knowledge repository format version 2 and namespace/documents/omissions fields'
    );
  const files = new Set<string>();
  const directories = new Map<string, string>();
  for (const file of result.data.documents) {
    portableKnowledgeFile(file);
    const key = folded(file);
    if (files.has(key) || directories.has(key)) throw new Error('Repository filename collision');
    files.add(key);
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const fk = folded(parent);
      if (files.has(fk) || (directories.has(fk) && directories.get(fk) !== parent))
        throw new Error('Repository directory collision');
      directories.set(fk, parent);
    }
  }
  return result.data;
}

/** Map a complete logical tree, including folder/file and Unicode/case collisions. */
export function knowledgeRepositoryFiles(
  paths: string[],
  previous = new Map<string, string>()
): Map<string, string> {
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate logical Knowledge path');
  type Node = {
    name: string;
    identity: string;
    preferred?: string;
    document?: string;
    children?: Map<string, Node>;
  };
  const root = new Map<string, Node>();
  for (const path of [...paths].sort()) {
    normalizeKnowledgePath(path);
    let level = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      const name = parts[i];
      const key = `${leaf ? 'file' : 'dir'}:${name}`;
      if (!level.has(key))
        level.set(key, {
          name,
          identity: `${leaf ? 'file' : 'dir'}:${parts.slice(0, i + 1).join('/')}`,
          ...(leaf ? { document: path } : { children: new Map() }),
        });
      const node = level.get(key)!;
      const preferred = previous.get(path)?.split('/')[i + 1];
      if (preferred) {
        if (node.preferred && node.preferred !== preferred)
          throw new Error('Inconsistent previous folder mapping');
        node.preferred = preferred;
      }
      if (!leaf) level = node.children!;
    }
  }
  const result = new Map<string, string>();
  const walk = (level: Map<string, Node>, prefix: string) => {
    const candidates = [...level.values()].map((node) => {
      if (node.preferred) return { node, name: node.preferred, changed: false };
      let name = node.name.normalize('NFC');
      if (name.startsWith('.')) name = `_${name.slice(1)}`;
      if (node.document && !name.endsWith('.md')) name += '.md';
      // Bound bytes, not UTF-16 code units. The identity suffix below disambiguates truncation.
      let shortened = '';
      for (const char of name) {
        if (Buffer.byteLength(shortened + char) > 160) break;
        shortened += char;
      }
      return {
        node,
        name: shortened,
        changed: shortened !== node.name && !(node.document && shortened === `${node.name}.md`),
      };
    });
    const counts = new Map<string, number>();
    for (const { name } of candidates)
      counts.set(folded(name), (counts.get(folded(name)) ?? 0) + 1);
    const used = new Set<string>();
    // Reserve unchanged names first, so a generated suffix cannot steal one.
    for (const c of candidates)
      if (c.node.preferred || (!c.changed && counts.get(folded(c.name)) === 1))
        used.add(folded(c.name));
    for (const c of candidates) {
      let name = c.name;
      if (!c.node.preferred && (c.changed || counts.get(folded(name))! > 1)) {
        const stem = c.node.document ? name.replace(/\.md$/, '') : name;
        const hash = transferSha256(c.node.identity);
        let length = 10;
        do {
          if (length > hash.length) throw new Error('Cannot allocate unique repository filename');
          name = `${stem}--${hash.slice(0, length++)}${c.node.document ? '.md' : ''}`;
        } while (used.has(folded(name)));
        used.add(folded(name));
      }
      const target = `${prefix}/${name}`;
      if (c.node.document) result.set(c.node.document, portableKnowledgeFile(target));
      else walk(c.node.children!, target);
    }
  };
  walk(root, 'docs');
  return result;
}

export function encodeKnowledgeDocument(header: KnowledgeRepositoryHeader, body: string): string {
  const parsed = knowledgeRepositoryHeaderSchema.safeParse(header);
  if (!parsed.success) throw new Error('Invalid Knowledge document metadata');
  if (Buffer.byteLength(body) > KNOWLEDGE_TRANSFER.maxDocumentBytes)
    throw new Error('Document body exceeds limit');
  const envelope = `---\n${serializeKnowledgeYaml(parsed.data)}---\n`;
  if (Buffer.byteLength(envelope) > KNOWLEDGE_TRANSFER.maxManifestBytes)
    throw new Error('Knowledge document header exceeds metadata limit');
  return envelope + body;
}

export function decodeKnowledgeDocument(text: string) {
  if (Buffer.byteLength(text) > KNOWLEDGE_REPOSITORY.maxFileBytes)
    throw new Error('Knowledge document file exceeds limit');
  const opening = /^(?:\uFEFF)?---\r?\n/.exec(text);
  if (!opening) throw new Error('Knowledge document requires a version 2 YAML header');
  const closing = /^---\r?\n/gm;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(text);
  if (!end) throw new Error('Knowledge document YAML header is not closed');
  const parsed = knowledgeRepositoryHeaderSchema.safeParse(
    parseKnowledgeYaml(text.slice(opening[0].length, end.index))
  );
  if (!parsed.success)
    throw new Error(
      'Invalid Knowledge document header: check format/version and agor id/path/title/kind/status fields'
    );
  const body = text.slice(end.index + end[0].length);
  if (Buffer.byteLength(body) > KNOWLEDGE_TRANSFER.maxDocumentBytes)
    throw new Error('Document body exceeds limit');
  return { header: parsed.data, body };
}

/** Internal transfer plan: identity depends on semantic content, never YAML layout. */
export function repositoryTransferManifest(
  manifest: KnowledgeRepositoryManifest,
  documents: Array<ReturnType<typeof decodeKnowledgeDocument>>
): KnowledgeTransferManifest {
  const ids = new Set<string>();
  return {
    format: KNOWLEDGE_TRANSFER.format,
    version: 1,
    completed: true,
    consistency: 'per-document-version; non-atomic-inventory',
    // Internal sentinel, not an assertion about source time or a tracked timestamp.
    exported_at: '1970-01-01T00:00:00Z',
    namespace: manifest.namespace,
    omissions: manifest.omissions,
    documents: [...documents]
      .sort((a, b) => (a.header.agor.id < b.header.agor.id ? -1 : 1))
      .map(({ header, body }, index) => {
        if (ids.has(header.agor.id)) throw new Error('Duplicate document identity');
        ids.add(header.agor.id);
        const { id, ...attributes } = header.agor;
        return {
          ...attributes,
          key: `d${String(index + 1).padStart(6, '0')}`,
          sha256: transferSha256(body),
          bytes: Buffer.byteLength(body),
          frontmatter: header.frontmatter,
          provenance: { ...header.provenance, source_uuid: id },
        };
      }),
  };
}

export function relativeKnowledgeFile(from: string, to: string): string {
  return posix.relative(posix.dirname(from), to).split('/').map(encodeMarkdownUrlSegment).join('/');
}

/** Only destinations of parsed Markdown links are transformed; prose/code stay byte-identical. */
export function exportRepositoryLinks(
  content: string,
  source: KnowledgeTransferManifest,
  files: Map<string, string>,
  from: string
) {
  const byId = new Map(source.documents.map((doc) => [doc.provenance.source_uuid, doc.path]));
  return rewriteKnowledgeLinks(content, (url) => {
    const match = /^(?:agor:\/\/kb\/|\/(?:ui\/)?(?:kb|knowledge)\/)([^/]+)\/(.*?)([?#].*)?$/.exec(
      url
    );
    if (!match) return {};
    try {
      const path =
        match[1] === 'document' && url.startsWith('agor://kb/document/')
          ? byId.get(match[2])
          : decodeURIComponent(match[1]) === source.namespace.slug
            ? decodeURIComponent(match[2])
            : undefined;
      const target = path ? files.get(path) : undefined;
      return target
        ? { value: relativeKnowledgeFile(from, target) + (match[3] ?? '') }
        : { unresolved: true };
    } catch {
      return { unresolved: true };
    }
  });
}

export function importRepositoryLinks(
  content: string,
  from: string,
  paths: Map<string, string>,
  targetSlug: string
) {
  return rewriteKnowledgeLinks(content, (url) => {
    if (!url || url.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) return {};
    const match = /^(.*?)([?#].*)?$/.exec(url)!;
    try {
      const local = decodeURIComponent(match[1]);
      if (local.includes('\\') || local.includes('\0')) return { unresolved: true };
      const target = posix.normalize(posix.join(posix.dirname(from), local));
      const path = paths.get(target);
      return path
        ? {
            value: `agor://kb/${targetSlug}/${path.split('/').map(encodeMarkdownUrlSegment).join('/')}${match[2] ?? ''}`,
          }
        : { unresolved: true };
    } catch {
      return { unresolved: true };
    }
  });
}
