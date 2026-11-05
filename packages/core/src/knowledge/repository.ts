import { posix } from 'node:path';
import { dump, JSON_SCHEMA, load } from 'js-yaml';
import { normalizeKnowledgePath } from '../types/knowledge.js';
import {
  KNOWLEDGE_REPOSITORY,
  KNOWLEDGE_TRANSFER,
  type KnowledgeRepositoryHeader,
  type KnowledgeRepositoryManifest,
  type KnowledgeTransferEntry,
  type KnowledgeTransferManifest,
  knowledgeRepositoryHeaderSchema,
  knowledgeRepositoryManifestSchema,
} from '../types/knowledge-transfer.js';
import { transferCanonical, transferSha256, validateTransferManifest } from './transfer.js';
import {
  encodeMarkdownUrlSegment,
  KNOWLEDGE_LINK,
  outsideKnowledgeLink,
  rewriteKnowledgeLinks,
  transferLinkResolver,
} from './transfer-links.js';

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
    const match = KNOWLEDGE_LINK.exec(url);
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

/**
 * Repository v2 writer shared by `agor kb export` and the `.agorpack` exporter:
 * maps logical paths to portable files (keeping `previous` names), rewrites
 * links to relative files and enforces the serialized limits the reader checks.
 */
export function knowledgeRepositoryWriter(
  manifest: KnowledgeTransferManifest,
  previous?: Map<string, string>
) {
  const files = knowledgeRepositoryFiles(
    manifest.documents.map((doc) => doc.path),
    previous
  );
  const index = validateRepositoryManifest({
    format: manifest.format,
    version: 2,
    namespace: manifest.namespace,
    documents: [...files.values()].sort(),
    omissions: manifest.omissions,
  });
  let bodyBytes = 0;
  let metadataBytes = 0;
  return {
    files,
    index,
    /** Encode one manifest document whose current Markdown is `body`. */
    document(doc: KnowledgeTransferEntry, body: string) {
      const file = files.get(doc.path);
      if (!file) throw new Error('Document is not in the repository plan');
      const links = exportRepositoryLinks(body, manifest, files, file);
      const {
        key: _key,
        sha256: _sha,
        bytes: _bytes,
        frontmatter,
        provenance,
        ...attributes
      } = doc;
      const content = encodeKnowledgeDocument(
        {
          format: KNOWLEDGE_REPOSITORY.documentFormat,
          version: 2,
          agor: { id: String(provenance.source_uuid), ...attributes },
          frontmatter,
          provenance,
        },
        links.content
      );
      bodyBytes += Buffer.byteLength(links.content);
      metadataBytes += Buffer.byteLength(content) - Buffer.byteLength(links.content);
      if (
        bodyBytes > KNOWLEDGE_TRANSFER.maxTotalBytes ||
        metadataBytes > KNOWLEDGE_TRANSFER.maxManifestBytes
      )
        throw new Error('Repository exceeds serialized body/metadata limits');
      return { file, content, unresolved: links.unresolved };
    },
    /** `manifest.yaml` contents. */
    manifestYaml: () => serializeKnowledgeYaml(index),
  };
}

export type DecodedKnowledgeRepositoryFile = ReturnType<typeof decodeKnowledgeDocument> & {
  file: string;
};

/** Decode one file listed in `manifest.yaml`; errors name the file. */
export function decodeKnowledgeRepositoryFile(
  file: string,
  text: string | null | undefined
): DecodedKnowledgeRepositoryFile {
  if (text === null || text === undefined)
    throw new Error(`Missing indexed Knowledge document: ${file}`);
  try {
    return { ...decodeKnowledgeDocument(text), file };
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}

/**
 * Import plan for a decoded repository v2 (in `index.documents` order), shared
 * by `agor kb import` and the `.agorpack` importer. Source Knowledge URLs and
 * relative file links are rewritten to `targetSlug`; manifest entries describe
 * the rewritten bodies. `unresolved` counts every link left as-is; `outside`
 * is the subset that points at other namespaces or documents outside the
 * repository, which transfers keep by design. `localize` applies the same
 * rewriting to any other body of a document (e.g. an older version).
 */
export function planKnowledgeRepositoryImport(
  index: KnowledgeRepositoryManifest,
  decoded: DecodedKnowledgeRepositoryFile[],
  targetSlug = index.namespace.slug
) {
  const source = validateTransferManifest(repositoryTransferManifest(index, decoded));
  const paths = new Map(decoded.map((doc) => [doc.file, doc.header.agor.path]));
  const sourceIds = new Set(source.documents.map((doc) => String(doc.provenance.source_uuid)));
  const resolve = transferLinkResolver(source, targetSlug);
  const localize = (body: string, file: string) => {
    let outside = 0;
    // Rewrite original source URLs first; otherwise generated destination URLs
    // are mistaken for unresolved source links when importing to a new namespace.
    const linked = rewriteKnowledgeLinks(body, (url) => {
      const result = resolve(url);
      if (
        result.unresolved &&
        outsideKnowledgeLink(url, source.namespace.slug, (id) => sourceIds.has(id))
      )
        outside++;
      return result;
    });
    const relative = importRepositoryLinks(linked.content, file, paths, targetSlug);
    return {
      content: relative.content,
      unresolved: linked.unresolved + relative.unresolved,
      outside,
    };
  };
  const byId = new Map(decoded.map((doc) => [doc.header.agor.id, doc]));
  const documents = new Map<string, { file: string; content: string }>();
  let unresolved = 0;
  let outside = 0;
  for (const entry of source.documents) {
    const doc = byId.get(String(entry.provenance.source_uuid));
    if (!doc) throw new Error('Repository document identity mismatch');
    const local = localize(doc.body, doc.file);
    unresolved += local.unresolved;
    outside += local.outside;
    entry.sha256 = transferSha256(local.content);
    entry.bytes = Buffer.byteLength(local.content);
    documents.set(entry.key, { file: doc.file, content: local.content });
  }
  return { manifest: validateTransferManifest(source), documents, unresolved, outside, localize };
}
