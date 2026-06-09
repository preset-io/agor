const KNOWLEDGE_URI_PREFIX = 'agor://kb/';

export const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const decodeKnowledgeRoutePath = (value?: string) =>
  (value ?? '').split('/').filter(Boolean).map(safeDecodeURIComponent).join('/');

export const encodeKnowledgeRoutePath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

export const getKnowledgeRouteBase = (pathname: string) =>
  pathname.startsWith('/knowledge') ? '/knowledge' : '/kb';

export const buildKnowledgeRoutePath = (
  basePath: string,
  namespaceSlug?: string | null,
  documentPath?: string | null
) => {
  if (!namespaceSlug || namespaceSlug === 'all') return basePath;
  const encodedNamespace = encodeURIComponent(namespaceSlug);
  const encodedDocumentPath = documentPath ? encodeKnowledgeRoutePath(documentPath) : '';
  return encodedDocumentPath
    ? `${basePath}/${encodedNamespace}/${encodedDocumentPath}`
    : `${basePath}/${encodedNamespace}`;
};

// Non-throwing slug extraction from a `agor://kb/<slug>/<path>` URI. Unlike
// parseKnowledgeUri (which normalizes/validates the path and throws), this only
// pulls the namespace slug so one malformed doc can't break route consumers.
export const namespaceSlugFromUri = (uri?: string | null): string | null => {
  if (!uri?.startsWith(KNOWLEDGE_URI_PREFIX)) return null;
  const rest = uri.slice(KNOWLEDGE_URI_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
};
