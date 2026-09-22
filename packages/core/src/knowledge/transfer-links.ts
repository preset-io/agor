import { fromMarkdown } from 'mdast-util-from-markdown';

type Root = ReturnType<typeof fromMarkdown>;
type RootContent = Root['children'][number];

import type { KnowledgeTransferManifest } from '../types/knowledge-transfer';

/** Rewrite only parsed link/image destinations and definitions; never code/prose. */
export function rewriteTransferLinks(
  content: string,
  manifest: KnowledgeTransferManifest,
  targetSlug: string
) {
  const byId = new Map(manifest.documents.map((doc) => [doc.provenance.source_uuid, doc]));
  const byPath = new Map(manifest.documents.map((doc) => [doc.path, doc]));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let unresolved = 0;
  const visit = (node: Root | RootContent) => {
    if (
      (node.type === 'link' || node.type === 'image' || node.type === 'definition') &&
      node.position
    ) {
      const url = node.url;
      const match = /^(?:agor:\/\/kb\/|\/(?:ui\/)?(?:kb|knowledge)\/)([^/]+)\/(.*?)([?#].*)?$/.exec(
        url
      );
      if (match) {
        let doc: KnowledgeTransferManifest['documents'][number] | undefined;
        try {
          doc =
            match[1] === 'document' && url.startsWith('agor://kb/document/')
              ? byId.get(match[2])
              : decodeURIComponent(match[1]) === manifest.namespace.slug
                ? byPath.get(decodeURIComponent(match[2]))
                : undefined;
        } catch {
          /* malformed URLs are preserved and reported */
        }
        if (doc) {
          const start = node.position.start.offset!;
          const end = node.position.end.offset!;
          const raw = content.slice(start, end);
          // mdast positions bound the node, not its URL. Locate the exact destination;
          // unusual escaped/entity spellings are reported rather than guessed.
          const destination = node.type === 'definition' ? /^\s*\[[^\]]+\]:\s*<?/ : /\]\(\s*<?/;
          const marker = destination.exec(raw);
          const offset = raw === `<${url}>` ? 1 : marker ? marker.index + marker[0].length : -1;
          if (offset >= 0 && raw.slice(offset, offset + url.length) === url)
            replacements.push({
              start: start + offset,
              end: start + offset + url.length,
              value: `agor://kb/${targetSlug}/${doc.path.split('/').map(encodeURIComponent).join('/')}${match[3] ?? ''}`,
            });
          else unresolved++;
        } else unresolved++;
      }
    }
    if ('children' in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(fromMarkdown(content));
  let rewritten = content;
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    rewritten =
      rewritten.slice(0, replacement.start) + replacement.value + rewritten.slice(replacement.end);
  return { content: rewritten, unresolved };
}
