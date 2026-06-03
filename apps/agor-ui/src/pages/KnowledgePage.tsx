import type {
  KnowledgeDocument as CoreKnowledgeDocument,
  KnowledgeNamespace as CoreKnowledgeNamespace,
  KnowledgeDocumentVersion as CoreKnowledgeVersion,
  KnowledgeDocumentKind,
} from '@agor/core/types';
import {
  hasMinimumRole,
  normalizeKnowledgeFolderPath,
  ROLES,
  titleFromKnowledgeContent,
  validateKnowledgePath as validateSharedKnowledgePath,
} from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HistoryOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  UpOutlined,
} from '@ant-design/icons';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Layout,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Tree,
  Typography,
  theme,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';
import { CodeEditor } from '../components/CodeEditor';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { DiffBlock } from '../components/ToolUseRenderer/renderers/DiffBlock';
import { useThemedModal } from '../utils/modal';

const { Header, Content } = Layout;
const { Text, Title } = Typography;

interface KnowledgeNamespace
  extends Omit<CoreKnowledgeNamespace, 'created_at' | 'updated_at' | 'archived_at'> {
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  archived_at?: string | Date | null;
}

interface KnowledgeDocument
  extends Omit<CoreKnowledgeDocument, 'created_at' | 'updated_at' | 'archived_at'> {
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  archived_at?: string | Date | null;
}

interface KnowledgeVersion extends Omit<CoreKnowledgeVersion, 'created_at' | 'content_blob'> {
  created_at: string | Date;
}

interface KnowledgeSearchResult {
  document: KnowledgeDocument;
  namespace: KnowledgeNamespace;
  current_version?: KnowledgeVersion | null;
  snippet?: string | null;
  score: number;
}

interface KnowledgePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
}

const DEFAULT_MARKDOWN = `# New Knowledge Page\n\nWrite markdown here.\n`;
const DRAFT_DOCUMENT_ID = '__knowledge_draft__' as CoreKnowledgeDocument['document_id'];
const ROOT_FOLDER = '';
const DEFAULT_FOLDERS = ['pages', 'skills', 'memories'];

const kindLabels: Record<KnowledgeDocumentKind, string> = {
  doc: 'Page',
  memory: 'Memory',
  skill: 'Skill',
  prompt: 'Prompt',
  guide: 'Guide',
  decision: 'Decision',
  bundle: 'Bundle',
  external: 'Reference',
};

const kindForSegment = (segment: string): KnowledgeDocumentKind | undefined => {
  if (segment === 'Pages') return 'doc';
  if (segment === 'Skills') return 'skill';
  if (segment === 'Memories') return 'memory';
  return undefined;
};

const kindFilterToUrlParam = (filter: string) => {
  if (filter === 'Pages') return 'pages';
  if (filter === 'Skills') return 'skills';
  if (filter === 'Memories') return 'memories';
  return null;
};

const kindFilterFromUrlParam = (value: string | null) => {
  if (value === 'pages') return 'Pages';
  if (value === 'skills') return 'Skills';
  if (value === 'memories') return 'Memories';
  return 'All';
};

const safeDecodeURIComponent = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const decodeKnowledgeRoutePath = (value?: string) =>
  (value ?? '').split('/').filter(Boolean).map(safeDecodeURIComponent).join('/');

const encodeKnowledgeRoutePath = (path: string) =>
  path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const getKnowledgeRouteBase = (pathname: string) =>
  pathname.startsWith('/knowledge') ? '/knowledge' : '/kb';

const buildKnowledgeRoutePath = (
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

const normalizeFindResult = <T,>(result: T[] | { data?: T[] }): T[] =>
  Array.isArray(result) ? result : (result.data ?? []);

const normalizeFolderPath = (folder?: string | null) => {
  try {
    return normalizeKnowledgeFolderPath(folder);
  } catch {
    return (folder ?? '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\/+/g, '/');
  }
};

const validateKnowledgePath = (path: string, { allowEmpty = false } = {}): string | null =>
  validateSharedKnowledgePath(path, { allowEmpty });

const parentFolderForPath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
};

const basenameForPath = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

const slugifyFileName = (value: string) => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'untitled'}.md`;
};

const inferTitleFromMarkdown = (markdown: string, fallback = 'Untitled') =>
  titleFromKnowledgeContent(markdown, fallback);

const stripFirstMarkdownTitleLine = (markdown: string) => {
  const lines = markdown.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex === -1) return markdown;
  return lines
    .filter((_, index) => index !== firstContentIndex)
    .join('\n')
    .replace(/^\s*\n/, '');
};

const formatTimestamp = (value?: string | Date | null) => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

const joinKnowledgePath = (folder: string, fileName: string) => {
  const normalizedFolder = normalizeFolderPath(folder);
  const normalizedFileName = basenameForPath(fileName).replace(/^\/+/, '') || 'untitled.md';
  return normalizedFolder ? `${normalizedFolder}/${normalizedFileName}` : normalizedFileName;
};

const ensureUniquePath = (path: string, docs: KnowledgeDocument[], ignoreId?: string) => {
  const existing = new Set(
    docs.filter((doc) => doc.document_id !== ignoreId).map((doc) => doc.path.toLowerCase())
  );
  if (!existing.has(path.toLowerCase())) return path;

  const folder = parentFolderForPath(path);
  const leaf = basenameForPath(path);
  const match = leaf.match(/^(.*?)(\.[^.]+)?$/);
  const stem = match?.[1] || 'untitled';
  const ext = match?.[2] || '';
  let index = 2;
  let candidate = joinKnowledgePath(folder, `${stem}-${index}${ext}`);
  while (existing.has(candidate.toLowerCase())) {
    index += 1;
    candidate = joinKnowledgePath(folder, `${stem}-${index}${ext}`);
  }
  return candidate;
};

interface KnowledgeTreeNode extends DataNode {
  kind: 'folder' | 'document';
  folderPath?: string;
  documentId?: string;
  children?: KnowledgeTreeNode[];
}

interface FolderSection {
  path: string;
  name: string;
  children: FolderSection[];
  docs: KnowledgeDocument[];
}

export function KnowledgePage({ client, currentUser = null }: KnowledgePageProps) {
  const { token } = theme.useToken();
  const { confirm } = useThemedModal();
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams<{ namespaceSlug?: string; '*'?: string }>();
  const routeNamespaceSlug = routeParams.namespaceSlug
    ? safeDecodeURIComponent(routeParams.namespaceSlug)
    : null;
  const routeDocumentPath = decodeKnowledgeRoutePath(routeParams['*']);
  const routeBasePath = getKnowledgeRouteBase(location.pathname);
  const routeSearchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const [namespaces, setNamespaces] = useState<KnowledgeNamespace[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [draftDocument, setDraftDocument] = useState<KnowledgeDocument | null>(null);
  const [draftNamespaceSlug, setDraftNamespaceSlug] = useState<string | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [activeSpace, setActiveSpace] = useState(() => routeNamespaceSlug ?? 'global');
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState(ROOT_FOLDER);
  const [expandedTreeKeys, setExpandedTreeKeys] = useState<React.Key[]>([
    'folder:',
    ...DEFAULT_FOLDERS.map((folder) => `folder:${folder}`),
  ]);
  const [titleDraft, setTitleDraft] = useState('');
  const [visibilityDraft, setVisibilityDraft] = useState<KnowledgeDocument['visibility']>('public');
  const [titleFromContent, setTitleFromContent] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState(DEFAULT_MARKDOWN);
  const [searchQuery, setSearchQuery] = useState(() => routeSearchParams.get('q') ?? '');
  const [kindFilter, setKindFilter] = useState<string>(() =>
    kindFilterFromUrlParam(routeSearchParams.get('kind'))
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createKind, setCreateKind] = useState<KnowledgeDocumentKind>('doc');
  const [createTitle, setCreateTitle] = useState('New Page');
  const [createNamespace, setCreateNamespace] = useState('global');
  const [createFolder, setCreateFolder] = useState('pages');
  const [localFolders, setLocalFolders] = useState<string[]>([]);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [newFolderParent, setNewFolderParent] = useState(ROOT_FOLDER);
  const [newFolderName, setNewFolderName] = useState('');
  const [isEditing, setIsEditing] = useState(() => routeSearchParams.get('mode') === 'edit');
  const pendingEditModeRef = useRef<boolean | null>(null);
  const activeDocIdRef = useRef<string | null>(activeDocId);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [relocateModalOpen, setRelocateModalOpen] = useState(false);
  const [relocateFolder, setRelocateFolder] = useState(ROOT_FOLDER);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<'preview' | 'diff'>('preview');
  const [titleActionsVisible, setTitleActionsVisible] = useState(false);
  const [renamePathOnTitleChange, setRenamePathOnTitleChange] = useState(false);

  useEffect(() => {
    document.title = 'Knowledge · Agor';
  }, []);

  useEffect(() => {
    activeDocIdRef.current = activeDocId;
  }, [activeDocId]);

  const activeDoc = useMemo(
    () =>
      activeDocId === DRAFT_DOCUMENT_ID
        ? draftDocument
        : activeDocId
          ? (documents.find((doc) => doc.document_id === activeDocId) ?? null)
          : null,
    [documents, draftDocument, activeDocId]
  );
  const isDraftDocument = activeDoc?.document_id === DRAFT_DOCUMENT_ID;

  const selectedNamespace = useMemo(
    () => namespaces.find((ns) => ns.slug === activeSpace) ?? namespaces[0] ?? null,
    [namespaces, activeSpace]
  );

  const namespaceSlugById = useMemo(() => {
    const map = new Map<string, string>();
    for (const namespace of namespaces) map.set(namespace.namespace_id, namespace.slug);
    return map;
  }, [namespaces]);

  const namespaceSlugForDocument = useCallback(
    (doc: KnowledgeDocument) =>
      namespaceSlugById.get(doc.namespace_id) ??
      (activeSpace !== 'all' ? activeSpace : selectedNamespace?.slug) ??
      'global',
    [activeSpace, namespaceSlugById, selectedNamespace?.slug]
  );

  const nextDraftTitle = useMemo(() => {
    if (!activeDoc) return 'Untitled';
    return titleFromContent
      ? inferTitleFromMarkdown(markdownDraft, activeDoc.title)
      : titleDraft.trim() || activeDoc.title;
  }, [activeDoc, markdownDraft, titleDraft, titleFromContent]);

  const titleChanged = Boolean(activeDoc && nextDraftTitle.trim() !== activeDoc.title.trim());

  const suggestedRenamePath = useMemo(() => {
    if (!activeDoc) return '';
    return ensureUniquePath(
      joinKnowledgePath(parentFolderForPath(activeDoc.path), slugifyFileName(nextDraftTitle)),
      documents,
      activeDoc.document_id
    );
  }, [activeDoc, documents, nextDraftTitle]);

  const buildKnowledgeSearch = useCallback(
    (overrides: { query?: string; kind?: string; editing?: boolean } = {}) => {
      const params = new URLSearchParams();
      const query = overrides.query ?? searchQuery;
      const kind = overrides.kind ?? kindFilter;
      const editing = overrides.editing ?? isEditing;
      const kindParam = kindFilterToUrlParam(kind);

      if (query.trim()) params.set('q', query.trim());
      if (kindParam) params.set('kind', kindParam);
      if (editing && activeDocId) params.set('mode', 'edit');

      const serialized = params.toString();
      return serialized ? `?${serialized}` : '';
    },
    [activeDocId, isEditing, kindFilter, searchQuery]
  );

  const folderPaths = useMemo(() => {
    const folders = new Set<string>([ROOT_FOLDER, ...DEFAULT_FOLDERS, ...localFolders]);
    for (const doc of documents) {
      const parts = doc.path.split('/').filter(Boolean);
      parts.pop();
      let cursor = '';
      for (const part of parts) {
        cursor = cursor ? `${cursor}/${part}` : part;
        folders.add(cursor);
      }
    }
    return [...folders].sort((a, b) => {
      if (a === ROOT_FOLDER) return -1;
      if (b === ROOT_FOLDER) return 1;
      return a.localeCompare(b);
    });
  }, [documents, localFolders]);

  const folderOptions = useMemo(
    () =>
      folderPaths.map((folder) => ({
        label: folder || 'Root',
        value: folder,
      })),
    [folderPaths]
  );

  const folderHierarchy = useMemo(() => {
    const root: FolderSection = { path: ROOT_FOLDER, name: 'Root', children: [], docs: [] };
    const folderMap = new Map<string, FolderSection>([[ROOT_FOLDER, root]]);

    const ensureFolder = (folderPath: string): FolderSection => {
      const normalized = normalizeFolderPath(folderPath);
      const existing = folderMap.get(normalized);
      if (existing) return existing;

      const parent = ensureFolder(parentFolderForPath(normalized));
      const node: FolderSection = {
        path: normalized,
        name: basenameForPath(normalized),
        children: [],
        docs: [],
      };
      folderMap.set(normalized, node);
      parent.children.push(node);
      return node;
    };

    for (const folder of folderPaths) ensureFolder(folder);
    for (const doc of documents) ensureFolder(parentFolderForPath(doc.path)).docs.push(doc);

    const sortFolder = (folder: FolderSection) => {
      folder.children.sort((a, b) => a.name.localeCompare(b.name));
      folder.docs.sort((a, b) => a.title.localeCompare(b.title));
      folder.children.forEach(sortFolder);
    };
    sortFolder(root);
    return root;
  }, [documents, folderPaths]);

  const relocateTreeData = useMemo<KnowledgeTreeNode[]>(() => {
    const toTreeNode = (folder: FolderSection): KnowledgeTreeNode => ({
      key: `folder:${folder.path}`,
      title: folder.name,
      kind: 'folder',
      folderPath: folder.path,
      children: folder.children.map(toTreeNode),
    });
    return [toTreeNode(folderHierarchy)];
  }, [folderHierarchy]);

  const createPathPreview = useMemo(() => {
    const namespaceSlug = createNamespace || (activeSpace === 'all' ? 'global' : activeSpace);
    return `agor://kb/${namespaceSlug}/${joinKnowledgePath(createFolder, slugifyFileName(createTitle))}`;
  }, [activeSpace, createFolder, createNamespace, createTitle]);

  const selectedVersion = useMemo(
    () =>
      versions.find((version) => version.version_id === selectedVersionId) ?? versions[0] ?? null,
    [selectedVersionId, versions]
  );

  const previousVersion = useMemo(() => {
    if (!selectedVersion) return null;
    const index = versions.findIndex(
      (version) => version.version_id === selectedVersion.version_id
    );
    return index >= 0 ? (versions[index + 1] ?? null) : null;
  }, [selectedVersion, versions]);
  const editCount = Math.max(versions.length - 1, 0);
  const savedMarkdown = versions[0]?.content_text ?? DEFAULT_MARKDOWN;
  const hasUnsavedChanges =
    isEditing &&
    Boolean(
      isDraftDocument ||
        (activeDoc &&
          (markdownDraft !== savedMarkdown ||
            titleDraft !== activeDoc.title ||
            visibilityDraft !== activeDoc.visibility ||
            titleFromContent !== (activeDoc.metadata?.title_from_content === true) ||
            renamePathOnTitleChange))
    );
  const canManageActiveVisibility =
    isDraftDocument ||
    Boolean(
      activeDoc &&
        (hasMinimumRole(currentUser?.role, ROLES.ADMIN) ||
          (currentUser?.user_id && activeDoc.created_by === currentUser.user_id))
    );

  const loadNamespaces = useCallback(async () => {
    if (!client) return;
    const result = await client.service('kb/namespaces').find({ query: { archived: false } });
    const rows = normalizeFindResult<KnowledgeNamespace>(result as KnowledgeNamespace[]);
    setNamespaces(rows);
    if (!rows.some((ns) => ns.slug === activeSpace)) {
      setActiveSpace(rows.find((ns) => ns.slug === 'global')?.slug ?? rows[0]?.slug ?? 'global');
    }
  }, [client, activeSpace]);

  const loadDocuments = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      await loadNamespaces();
      const kind = kindForSegment(kindFilter);
      const namespaceFilter = activeSpace === 'all' ? undefined : activeSpace;
      if (searchQuery.trim()) {
        const result = await client.service('kb/search').find({
          query: {
            q: searchQuery.trim(),
            namespace_slug: namespaceFilter,
            kind,
            limit: 50,
          },
        });
        const rows = normalizeFindResult<KnowledgeSearchResult>(result as KnowledgeSearchResult[]);
        setDocuments(rows.map((row) => row.document));
      } else {
        const result = await client.service('kb/documents').find({
          query: {
            namespace_slug: namespaceFilter,
            kind,
            archived: false,
          },
        });
        setDocuments(normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[]));
      }
    } catch (err) {
      console.error('Failed to load Knowledge:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, activeSpace, kindFilter, searchQuery, loadNamespaces]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const confirmDiscardUnsavedChanges = useCallback(async (): Promise<boolean> => {
    if (!hasUnsavedChanges) return true;
    return new Promise((resolve) => {
      confirm({
        title: 'Discard unsaved changes?',
        content:
          'This page has unsaved changes. If you navigate away now, those edits will be lost.',
        okText: 'Discard changes',
        okButtonProps: { danger: true },
        cancelText: 'Keep editing',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }, [confirm, hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    const nextSpace = routeNamespaceSlug ?? 'global';
    const nextQuery = routeSearchParams.get('q') ?? '';
    const nextKind = kindFilterFromUrlParam(routeSearchParams.get('kind'));
    const nextEditing =
      routeSearchParams.get('mode') === 'edit' &&
      (Boolean(routeDocumentPath) || routeSearchParams.get('draft') === 'page');

    if (
      !routeDocumentPath &&
      activeDocId &&
      !draftDocument &&
      activeDocIdRef.current !== DRAFT_DOCUMENT_ID
    ) {
      activeDocIdRef.current = null;
      setActiveDocId(null);
    }
    if (routeNamespaceSlug && nextSpace !== activeSpace) setActiveSpace(nextSpace);
    setSearchQuery((current) => (current === nextQuery ? current : nextQuery));
    if (nextKind !== kindFilter) setKindFilter(nextKind);
    const pendingEditMode = pendingEditModeRef.current;
    if (pendingEditMode === null) {
      if (nextEditing !== isEditing) setIsEditing(nextEditing);
    } else if (nextEditing === pendingEditMode) {
      pendingEditModeRef.current = null;
      if (nextEditing !== isEditing) setIsEditing(nextEditing);
    }
  }, [
    activeDocId,
    activeSpace,
    isEditing,
    kindFilter,
    routeDocumentPath,
    routeNamespaceSlug,
    routeSearchParams,
    draftDocument,
  ]);

  useEffect(() => {
    if (activeDocIdRef.current === DRAFT_DOCUMENT_ID) return;
    if (!routeNamespaceSlug || !routeDocumentPath) return;
    const routedDocument = documents.find(
      (doc) =>
        doc.path === routeDocumentPath && namespaceSlugForDocument(doc) === routeNamespaceSlug
    );
    if (routedDocument && routedDocument.document_id !== activeDocId) {
      activeDocIdRef.current = routedDocument.document_id;
      setActiveDocId(routedDocument.document_id);
    }
  }, [activeDocId, documents, namespaceSlugForDocument, routeDocumentPath, routeNamespaceSlug]);

  useEffect(() => {
    if (activeDocIdRef.current === DRAFT_DOCUMENT_ID) return;
    if (activeDocId && !activeDoc && !loading) {
      activeDocIdRef.current = null;
      setActiveDocId(null);
    }
  }, [activeDoc, activeDocId, loading]);

  useEffect(() => {
    if (activeDoc) {
      setSelectedFolder(parentFolderForPath(activeDoc.path));
      setTitleDraft(activeDoc.title);
      setVisibilityDraft(activeDoc.visibility);
      setTitleFromContent(activeDoc.metadata?.title_from_content === true);
      setRenamePathOnTitleChange(false);
      setIsEditing(pendingEditModeRef.current ?? routeSearchParams.get('mode') === 'edit');
    }
  }, [activeDoc, routeSearchParams]);

  useEffect(() => {
    if (!titleChanged) setRenamePathOnTitleChange(false);
  }, [titleChanged]);

  useEffect(() => {
    if (draftDocument) return;
    if (routeDocumentPath && !activeDoc) return;

    const routedDocument = routeDocumentPath
      ? documents.find(
          (doc) =>
            doc.path === routeDocumentPath &&
            (!routeNamespaceSlug || namespaceSlugForDocument(doc) === routeNamespaceSlug)
        )
      : null;
    if (routedDocument && routedDocument.document_id !== activeDocId) return;
    if (!routeDocumentPath && activeDoc) return;
    if (
      activeDoc &&
      routeNamespaceSlug &&
      routeNamespaceSlug !== namespaceSlugForDocument(activeDoc)
    ) {
      return;
    }

    const activeNamespaceSlug = activeDoc ? namespaceSlugForDocument(activeDoc) : activeSpace;
    const shouldKeepNamespaceRoute = Boolean(routeNamespaceSlug) && activeSpace !== 'all';
    const targetPath = activeDoc
      ? buildKnowledgeRoutePath(routeBasePath, activeNamespaceSlug, activeDoc.path)
      : shouldKeepNamespaceRoute
        ? buildKnowledgeRoutePath(routeBasePath, activeNamespaceSlug)
        : routeBasePath;
    const targetUrl = `${targetPath}${buildKnowledgeSearch()}`;
    const currentUrl = `${location.pathname}${location.search}`;

    if (targetUrl !== currentUrl) navigate(targetUrl, { replace: true });
  }, [
    activeDoc,
    activeDocId,
    activeSpace,
    buildKnowledgeSearch,
    documents,
    draftDocument,
    location.pathname,
    location.search,
    namespaceSlugForDocument,
    navigate,
    routeBasePath,
    routeDocumentPath,
    routeNamespaceSlug,
  ]);

  useEffect(() => {
    if (titleFromContent) {
      setTitleDraft(inferTitleFromMarkdown(markdownDraft, activeDoc?.title ?? 'Untitled'));
    }
  }, [activeDoc?.title, markdownDraft, titleFromContent]);

  useEffect(() => {
    if (activeSpace !== 'all') setCreateNamespace(activeSpace);
  }, [activeSpace]);

  const loadVersions = useCallback(async () => {
    if (isDraftDocument) {
      setVersions([]);
      return;
    }
    if (!client || !activeDoc) {
      setVersions([]);
      return;
    }
    const documentId = activeDoc.document_id;
    try {
      const result = await client.service('kb/versions').find({
        query: { document_id: documentId, include_content: true },
      });
      if (activeDocIdRef.current !== documentId) return;
      const rows = normalizeFindResult<KnowledgeVersion>(result as KnowledgeVersion[]);
      setVersions(rows);
      setSelectedVersionId((current) =>
        current && rows.some((row) => row.version_id === current)
          ? current
          : (rows[0]?.version_id ?? null)
      );
      setMarkdownDraft(rows[0]?.content_text ?? DEFAULT_MARKDOWN);
    } catch (err) {
      if (activeDocIdRef.current !== documentId) return;
      console.error('Failed to load Knowledge versions:', err);
      setVersions([]);
      setMarkdownDraft(DEFAULT_MARKDOWN);
    }
  }, [client, activeDoc, isDraftDocument]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const startNewPageDraft = async () => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    const namespaceSlug = activeSpace === 'all' ? 'global' : activeSpace;
    const namespace =
      namespaces.find((ns) => ns.slug === namespaceSlug) ?? selectedNamespace ?? namespaces[0];
    const title = 'Untitled';
    const path = ensureUniquePath(slugifyFileName(title), documents);
    const draft: KnowledgeDocument = {
      document_id: DRAFT_DOCUMENT_ID,
      namespace_id:
        namespace?.namespace_id ?? (DRAFT_DOCUMENT_ID as KnowledgeDocument['namespace_id']),
      path,
      uri: `agor://kb/${namespaceSlug}/${path}`,
      url: null,
      title,
      kind: 'doc',
      visibility: namespace?.visibility_default ?? 'public',
      edit_policy: 'owner',
      current_version_id: null,
      metadata: { title_from_content: true },
      created_by: null,
      created_at: new Date(),
      updated_by: null,
      updated_at: null,
      archived: false,
      archived_at: null,
    };
    setDraftDocument(draft);
    setDraftNamespaceSlug(namespaceSlug);
    activeDocIdRef.current = DRAFT_DOCUMENT_ID;
    setActiveDocId(DRAFT_DOCUMENT_ID);
    setSelectedFolder(ROOT_FOLDER);
    setTitleDraft(title);
    setVisibilityDraft(draft.visibility);
    setTitleFromContent(true);
    setRenamePathOnTitleChange(false);
    setMarkdownDraft(`# ${title}\n\nWrite markdown here.\n`);
    setVersions([]);
    pendingEditModeRef.current = true;
    setIsEditing(true);
    navigate(`${buildKnowledgeRoutePath(routeBasePath, namespaceSlug)}?draft=page&mode=edit`);
  };

  const openCreateModal = async (kind: KnowledgeDocumentKind) => {
    if (kind === 'doc') {
      await startNewPageDraft();
      return;
    }
    const title = kind === 'skill' ? 'New Skill' : kind === 'memory' ? 'New Memory' : 'New Page';
    const defaultFolder =
      selectedFolder || (kind === 'skill' ? 'skills' : kind === 'memory' ? 'memories' : 'pages');
    setCreateKind(kind);
    setCreateTitle(title);
    setCreateNamespace(activeSpace === 'all' ? 'global' : activeSpace);
    setCreateFolder(defaultFolder);
    setCreateModalOpen(true);
  };

  const openFolderModal = () => {
    setNewFolderParent(selectedFolder);
    setNewFolderName('');
    setFolderModalOpen(true);
  };

  const createLocalFolder = () => {
    const folderName = normalizeFolderPath(newFolderName);
    if (!folderName) return;
    const folderError = validateKnowledgePath(folderName);
    const parentError = validateKnowledgePath(newFolderParent, { allowEmpty: true });
    if (folderError || parentError) {
      setError(folderError ?? parentError);
      return;
    }
    const nextFolder = normalizeFolderPath([newFolderParent, folderName].filter(Boolean).join('/'));
    setLocalFolders((prev) => [...new Set([...prev, nextFolder])]);
    setSelectedFolder(nextFolder);
    setExpandedTreeKeys((prev) => [
      ...new Set([...prev, `folder:${newFolderParent}`, `folder:${nextFolder}`]),
    ]);
    setFolderModalOpen(false);
  };

  const createDocument = async () => {
    if (!client) return;
    const namespaceSlug = createNamespace || (activeSpace === 'all' ? 'global' : activeSpace);
    const folderError = validateKnowledgePath(createFolder, { allowEmpty: true });
    if (folderError) {
      setError(folderError);
      return;
    }
    const title =
      createTitle.trim() ||
      (createKind === 'skill' ? 'New Skill' : createKind === 'memory' ? 'New Memory' : 'New Page');
    const path = ensureUniquePath(
      joinKnowledgePath(createFolder, slugifyFileName(title)),
      documents
    );
    setSaving(true);
    setError(null);
    try {
      const created = (await client.service('kb/documents').create({
        namespace_slug: namespaceSlug,
        path,
        title,
        kind: createKind,
        visibility:
          namespaces.find((ns) => ns.slug === namespaceSlug)?.visibility_default ??
          selectedNamespace?.visibility_default ??
          'public',
        metadata: { title_from_content: true },
        content_text: `# ${title}\n\nWrite markdown here.\n`,
        change_summary: 'Initial version',
      })) as KnowledgeDocument;
      setDocuments((prev) => [created, ...prev]);
      setActiveSpace(namespaceSlug);
      activeDocIdRef.current = created.document_id;
      setActiveDocId(created.document_id);
      setSelectedFolder(parentFolderForPath(created.path));
      setMarkdownDraft(`# ${title}\n\nWrite markdown here.\n`);
      setExpandedTreeKeys((prev) => [
        ...new Set([...prev, `folder:${parentFolderForPath(created.path)}`]),
      ]);
      setCreateModalOpen(false);
    } catch (err) {
      console.error('Failed to create Knowledge document:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveActiveDocument = async () => {
    if (!client || !activeDoc) return;
    setSaving(true);
    setError(null);
    try {
      const nextTitle = nextDraftTitle;
      if (isDraftDocument) {
        const namespaceSlug =
          draftNamespaceSlug ?? (activeSpace === 'all' ? 'global' : activeSpace);
        const path = ensureUniquePath(slugifyFileName(nextTitle), documents);
        const created = (await client.service('kb/documents').create({
          namespace_slug: namespaceSlug,
          path,
          title: nextTitle,
          kind: 'doc',
          visibility: visibilityDraft,
          metadata: {
            ...(activeDoc.metadata ?? {}),
            title_from_content: titleFromContent,
          },
          content_text: markdownDraft,
          change_summary: 'Initial version',
        })) as KnowledgeDocument;
        setDocuments((prev) => [created, ...prev]);
        setDraftDocument(null);
        setDraftNamespaceSlug(null);
        setActiveSpace(namespaceSlug);
        activeDocIdRef.current = created.document_id;
        setActiveDocId(created.document_id);
        setSelectedFolder(parentFolderForPath(created.path));
        setVersions([]);
        pendingEditModeRef.current = false;
        setIsEditing(false);
        navigate(
          `${buildKnowledgeRoutePath(
            routeBasePath,
            namespaceSlugForDocument(created),
            created.path
          )}${buildKnowledgeSearch({ editing: false })}`,
          { replace: true }
        );
        return;
      }
      const nextPath =
        titleChanged && renamePathOnTitleChange && suggestedRenamePath !== activeDoc.path
          ? suggestedRenamePath
          : undefined;
      const updated = (await client.service('kb/documents').patch(activeDoc.document_id, {
        title: nextTitle,
        visibility: visibilityDraft,
        ...(nextPath ? { path: nextPath } : {}),
        content_text: markdownDraft,
        metadata: {
          ...(activeDoc.metadata ?? {}),
          title_from_content: titleFromContent,
        },
        change_summary: nextPath
          ? `Edited and renamed from ${activeDoc.path} to ${nextPath}`
          : 'Edited from Knowledge UI',
      })) as KnowledgeDocument;
      setDocuments((prev) =>
        prev.map((doc) => (doc.document_id === updated.document_id ? updated : doc))
      );
      await loadVersions();
      setKnowledgeEditMode(false);
    } catch (err) {
      console.error('Failed to save Knowledge document:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const moveDocumentToFolder = async (documentId: string, folder: string) => {
    if (!client) return;
    const doc = documents.find((item) => item.document_id === documentId);
    if (!doc) return;

    const targetFolder = normalizeFolderPath(folder);
    const folderError = validateKnowledgePath(targetFolder, { allowEmpty: true });
    if (folderError) {
      setError(folderError);
      return;
    }
    const nextPath = ensureUniquePath(
      joinKnowledgePath(targetFolder, basenameForPath(doc.path)),
      documents,
      doc.document_id
    );
    if (nextPath === doc.path) return;

    setSaving(true);
    setError(null);
    try {
      const updated = (await client.service('kb/documents').patch(doc.document_id, {
        path: nextPath,
        change_summary: `Moved to ${targetFolder || 'root'}`,
      })) as KnowledgeDocument;
      setDocuments((prev) =>
        prev.map((item) => (item.document_id === updated.document_id ? updated : item))
      );
      activeDocIdRef.current = updated.document_id;
      setActiveDocId(updated.document_id);
      setSelectedFolder(targetFolder);
      setExpandedTreeKeys((prev) => [...new Set([...prev, `folder:${targetFolder}`])]);
    } catch (err) {
      console.error('Failed to move Knowledge document:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    if (!activeDoc) return;
    if (isDraftDocument) {
      setDraftDocument(null);
      setDraftNamespaceSlug(null);
      activeDocIdRef.current = null;
      setActiveDocId(null);
      setTitleDraft('');
      setVisibilityDraft('public');
      setTitleFromContent(false);
      setRenamePathOnTitleChange(false);
      setMarkdownDraft(DEFAULT_MARKDOWN);
      setVersions([]);
      setKnowledgeEditMode(false);
      return;
    }
    setTitleDraft(activeDoc.title);
    setVisibilityDraft(activeDoc.visibility);
    setTitleFromContent(activeDoc.metadata?.title_from_content === true);
    setRenamePathOnTitleChange(false);
    setMarkdownDraft(versions[0]?.content_text ?? DEFAULT_MARKDOWN);
    setKnowledgeEditMode(false);
  };

  const openHistory = async () => {
    await loadVersions();
    setSelectedVersionId((current) => current ?? versions[0]?.version_id ?? null);
    setHistoryView('preview');
    setHistoryOpen(true);
  };

  const restoreSelectedVersion = async () => {
    if (!client || !activeDoc || !selectedVersion) return;
    const restoredContent = selectedVersion.content_text ?? '';
    const nextTitle = titleFromContent
      ? inferTitleFromMarkdown(restoredContent, activeDoc.title)
      : activeDoc.title;

    setSaving(true);
    setError(null);
    try {
      const updated = (await client.service('kb/documents').patch(activeDoc.document_id, {
        title: nextTitle,
        content_text: restoredContent,
        metadata: {
          ...(activeDoc.metadata ?? {}),
          title_from_content: titleFromContent,
        },
        change_summary: `Restored version ${selectedVersion.version_number}`,
      })) as KnowledgeDocument;
      setDocuments((prev) =>
        prev.map((doc) => (doc.document_id === updated.document_id ? updated : doc))
      );
      setMarkdownDraft(restoredContent);
      setTitleDraft(nextTitle);
      await loadVersions();
      setHistoryOpen(false);
    } catch (err) {
      console.error('Failed to restore Knowledge version:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteActiveDocument = () => {
    if (!client || !activeDoc) return;
    confirm({
      title: 'Delete this page?',
      content:
        'This soft-deletes the page from Knowledge. Version history remains in the database.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      async onOk() {
        if (!activeDoc) return;
        try {
          await client.service('kb/documents').remove(activeDoc.document_id);
          setDocuments((prev) => prev.filter((doc) => doc.document_id !== activeDoc.document_id));
          activeDocIdRef.current = null;
          setActiveDocId(null);
          setVersions([]);
          setSelectedVersionId(null);
        } catch (err) {
          console.error('Failed to delete Knowledge document:', err);
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    });
  };

  const toggleFolderCollapsed = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const setKnowledgeEditMode = (editing: boolean) => {
    pendingEditModeRef.current = editing;
    setIsEditing(editing);
    navigate(`${location.pathname}${buildKnowledgeSearch({ editing })}`, { replace: true });
  };

  const clearDraftDocument = () => {
    setDraftDocument(null);
    setDraftNamespaceSlug(null);
  };

  const selectKnowledgeDocument = async (doc: KnowledgeDocument) => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    clearDraftDocument();
    activeDocIdRef.current = doc.document_id;
    setActiveDocId(doc.document_id);
    pendingEditModeRef.current = false;
    setIsEditing(false);
    navigate(
      `${buildKnowledgeRoutePath(routeBasePath, namespaceSlugForDocument(doc), doc.path)}${buildKnowledgeSearch(
        { editing: false }
      )}`
    );
  };

  const changeKnowledgeSpace = async (space: string) => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    clearDraftDocument();
    setActiveSpace(space);
    activeDocIdRef.current = null;
    setActiveDocId(null);
    setSelectedFolder(ROOT_FOLDER);
    pendingEditModeRef.current = false;
    setIsEditing(false);
    const targetPath =
      space === 'all' ? routeBasePath : buildKnowledgeRoutePath(routeBasePath, space);
    navigate(`${targetPath}${buildKnowledgeSearch({ editing: false })}`);
  };

  const renderDocumentRow = (doc: KnowledgeDocument, depth = 0): React.ReactNode => (
    <button
      key={doc.document_id}
      type="button"
      onClick={() => selectKnowledgeDocument(doc)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minHeight: 30,
        margin: '1px 0',
        padding: '5px 8px',
        paddingLeft: 10 + depth * 16,
        border: 0,
        borderRadius: token.borderRadius,
        background:
          activeDoc?.document_id === doc.document_id ? token.colorPrimaryBg : 'transparent',
        color: token.colorText,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <FileOutlined style={{ color: token.colorTextTertiary, fontSize: 13 }} />
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: activeDoc?.document_id === doc.document_id ? 600 : 400,
        }}
      >
        {doc.title}
      </span>
    </button>
  );

  const shouldShowFolderInSidebar = (folder: FolderSection): boolean => {
    if (folder.path === ROOT_FOLDER) return true;
    const searchActive = Boolean(searchQuery.trim());
    const hasDocuments = folder.docs.length > 0;
    const hasVisibleChildren = folder.children.some(shouldShowFolderInSidebar);
    const isLocalEmptyFolder = localFolders.includes(folder.path);
    return hasDocuments || hasVisibleChildren || (!searchActive && isLocalEmptyFolder);
  };

  const renderFolderSection = (folder: FolderSection, depth = 0): React.ReactNode => {
    if (!shouldShowFolderInSidebar(folder)) return null;
    const visibleChildren = folder.children.filter(shouldShowFolderInSidebar);
    const childCount = folder.docs.length + visibleChildren.length;
    const hasChildren = childCount > 0;
    const collapsed = hasChildren && collapsedFolders.has(folder.path);
    const selected = !activeDoc && selectedFolder === folder.path;
    const isEmpty = childCount === 0;
    const showCount = collapsed || isEmpty;

    return (
      <div key={folder.path || 'root'}>
        <button
          type="button"
          onClick={() => {
            setSelectedFolder(folder.path);
            if (hasChildren) toggleFolderCollapsed(folder.path);
          }}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minHeight: 32,
            margin: '1px 0',
            padding: '6px 8px',
            paddingLeft: 10 + depth * 16,
            border: 0,
            borderRadius: token.borderRadius,
            background: selected ? token.colorPrimaryBg : 'transparent',
            color: isEmpty ? token.colorTextSecondary : token.colorText,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span
            style={{
              width: 16,
              display: 'inline-flex',
              justifyContent: 'center',
              color: token.colorTextTertiary,
            }}
          >
            {collapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: selected ? 600 : 500,
            }}
          >
            {folder.name}
          </span>
          {showCount && (
            <Tag
              bordered={false}
              color="default"
              style={{
                marginInlineEnd: 0,
                minWidth: 24,
                textAlign: 'center',
                color: isEmpty ? token.colorTextTertiary : undefined,
              }}
            >
              {childCount}
            </Tag>
          )}
          <span
            style={{
              width: 14,
              color: token.colorTextTertiary,
              display: 'inline-flex',
              justifyContent: 'center',
              fontSize: 10,
              marginLeft: 2,
            }}
          >
            {hasChildren ? collapsed ? <DownOutlined /> : <UpOutlined /> : null}
          </span>
        </button>

        {!collapsed && (
          <div>
            {visibleChildren.map((child) => renderFolderSection(child, depth + 1))}
            {folder.docs.map((doc) => renderDocumentRow(doc, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderRootContents = (): React.ReactNode => (
    <>
      {folderHierarchy.children
        .filter(shouldShowFolderInSidebar)
        .map((child) => renderFolderSection(child, 0))}
      {folderHierarchy.docs.map((doc) => renderDocumentRow(doc, 0))}
    </>
  );

  const spaceOptions = [
    { label: 'All Spaces', value: 'all' },
    ...namespaces.map((ns) => ({ label: ns.display_name || ns.slug, value: ns.slug })),
  ];
  const createFolderError = validateKnowledgePath(createFolder, { allowEmpty: true });
  const newFolderParentError = validateKnowledgePath(newFolderParent, { allowEmpty: true });
  const newFolderNameError = normalizeFolderPath(newFolderName)
    ? validateKnowledgePath(newFolderName)
    : null;
  const folderNameHelp =
    'Use letters, numbers, spaces, dashes, underscores, dots, and / for subfolders.';
  const showReadActions = titleActionsVisible;

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden', background: token.colorBgLayout }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 56,
          padding: '0 16px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space size={12}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={async () => {
              if (await confirmDiscardUnsavedChanges()) navigate('/');
            }}
          />
          <BrandLogo level={5} />
          <Text strong style={{ fontSize: 15 }}>
            Knowledge
          </Text>
          <Tooltip title="Knowledge is in beta — expect rough edges while the data model, MCP tools, and editor settle.">
            <Tag
              color="orange"
              style={{
                fontSize: 10,
                lineHeight: '16px',
                padding: '0 6px',
                margin: 0,
                cursor: 'help',
                userSelect: 'none',
              }}
            >
              BETA
            </Tag>
          </Tooltip>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadDocuments} loading={loading}>
            Refresh
          </Button>
        </Space>
      </Header>

      <Content
        style={{ height: 'calc(100vh - 56px)', display: 'flex', overflow: 'hidden', padding: 0 }}
      >
        <aside
          style={{
            width: 340,
            flexShrink: 0,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer,
            padding: 16,
            overflow: 'auto',
          }}
        >
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            {!client && <Alert type="warning" title="Knowledge requires a daemon connection." />}
            <Space orientation="vertical" size={4} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>
                Space
              </Text>
              <Select
                value={activeSpace}
                onChange={changeKnowledgeSpace}
                style={{ width: '100%' }}
                options={spaceOptions}
              />
            </Space>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Search Knowledge"
              value={searchQuery}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setSearchQuery(nextQuery);
                navigate(`${location.pathname}${buildKnowledgeSearch({ query: nextQuery })}`, {
                  replace: true,
                });
              }}
            />
            <Flex gap={8}>
              <Button
                block
                type="primary"
                icon={<FileAddOutlined />}
                onClick={() => openCreateModal('doc')}
                disabled={!client}
              >
                New Page
              </Button>
              <Button icon={<FolderAddOutlined />} onClick={openFolderModal} />
            </Flex>
            <Segmented
              block
              size="small"
              value={kindFilter}
              onChange={(value) => {
                const nextKind = String(value);
                setKindFilter(nextKind);
                navigate(`${location.pathname}${buildKnowledgeSearch({ kind: nextKind })}`, {
                  replace: true,
                });
              }}
              options={['All', 'Pages', 'Skills', 'Memories']}
            />
            <Spin spinning={loading}>
              <div
                style={{
                  background: token.colorFillQuaternary,
                  borderRadius: token.borderRadiusLG,
                  padding: 4,
                }}
              >
                {renderRootContents()}
              </div>
            </Spin>
          </Space>
        </aside>

        <main
          style={{
            flex: 1,
            minWidth: 0,
            overflow: isEditing ? 'hidden' : 'auto',
            background: token.colorBgLayout,
          }}
        >
          <div
            style={{
              maxWidth: isEditing ? 'none' : 1040,
              height: isEditing ? '100%' : undefined,
              margin: isEditing ? 0 : '0 auto',
              padding: isEditing ? 24 : '40px 56px',
              boxSizing: 'border-box',
              display: isEditing ? 'flex' : undefined,
              flexDirection: isEditing ? 'column' : undefined,
              minHeight: 0,
            }}
          >
            {error && (
              <Alert
                type="error"
                title="Knowledge error"
                description={error}
                closable
                onClose={() => setError(null)}
                style={{ marginBottom: 16 }}
              />
            )}

            {activeDoc ? (
              <div
                style={{
                  width: '100%',
                  height: isEditing ? '100%' : undefined,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                  minHeight: 0,
                }}
              >
                <div
                  onMouseEnter={() => setTitleActionsVisible(true)}
                  onMouseLeave={() => setTitleActionsVisible(false)}
                  onFocus={() => setTitleActionsVisible(true)}
                  onBlur={(event) => {
                    const nextTarget = event.relatedTarget as Node | null;
                    if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
                      setTitleActionsVisible(false);
                    }
                  }}
                  style={{
                    position: 'relative',
                    display: isEditing ? 'flex' : 'block',
                    alignItems: 'flex-start',
                    gap: 16,
                  }}
                >
                  <Space
                    orientation="vertical"
                    size={8}
                    style={{ width: '100%', minWidth: 0, flex: 1 }}
                  >
                    {isEditing && !titleFromContent ? (
                      <Input
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        placeholder="Page title"
                        size="large"
                        variant="borderless"
                        style={{ fontSize: 32, fontWeight: 700, paddingInline: 0 }}
                      />
                    ) : (
                      <Title level={1} style={{ margin: 0 }}>
                        {isEditing ? titleDraft : activeDoc.title}
                      </Title>
                    )}
                    <Space wrap>
                      {isEditing ? (
                        <Select
                          size="small"
                          value={visibilityDraft}
                          disabled={!canManageActiveVisibility}
                          onChange={setVisibilityDraft}
                          style={{ width: 104 }}
                          options={[
                            { label: 'Public', value: 'public' },
                            { label: 'Private', value: 'private' },
                          ]}
                        />
                      ) : (
                        <Tag color={activeDoc.visibility === 'public' ? 'green' : 'default'}>
                          {activeDoc.visibility}
                        </Tag>
                      )}
                      <Tag>{kindLabels[activeDoc.kind] ?? activeDoc.kind}</Tag>
                      <Text type="secondary">{activeDoc.path}</Text>
                    </Space>
                    {isEditing && (
                      <Space orientation="vertical" size={4}>
                        <Checkbox
                          checked={titleFromContent}
                          onChange={(event) => setTitleFromContent(event.target.checked)}
                        >
                          Use first heading as title
                        </Checkbox>
                        <Checkbox
                          checked={renamePathOnTitleChange}
                          disabled={!titleChanged}
                          onChange={(event) => setRenamePathOnTitleChange(event.target.checked)}
                        >
                          Rename page path to match title
                        </Checkbox>
                        {titleChanged && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            Current path: {activeDoc.path}
                            {renamePathOnTitleChange && ` → ${suggestedRenamePath}`}
                          </Text>
                        )}
                      </Space>
                    )}
                  </Space>

                  <Space
                    style={
                      isEditing
                        ? undefined
                        : {
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            zIndex: 2,
                            padding: 4,
                            borderRadius: token.borderRadiusLG,
                            background: token.colorBgContainer,
                            boxShadow: titleActionsVisible ? token.boxShadowSecondary : undefined,
                          }
                    }
                  >
                    {!isEditing ? (
                      <>
                        {showReadActions && (
                          <>
                            <Button
                              icon={<HistoryOutlined />}
                              disabled={!client}
                              onClick={openHistory}
                            >
                              History
                              {editCount > 0 && (
                                <Tag
                                  color="blue"
                                  variant="filled"
                                  style={{ marginInlineStart: 6, marginInlineEnd: 0 }}
                                >
                                  {editCount}
                                </Tag>
                              )}
                            </Button>
                            <Button
                              icon={<FolderOpenOutlined />}
                              disabled={!client}
                              onClick={() => {
                                setRelocateFolder(parentFolderForPath(activeDoc.path));
                                setRelocateModalOpen(true);
                              }}
                            >
                              Relocate
                            </Button>
                            <Button
                              danger
                              icon={<DeleteOutlined />}
                              disabled={!client}
                              onClick={deleteActiveDocument}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                        <Button
                          icon={<EditOutlined />}
                          disabled={!client}
                          onClick={() => setKnowledgeEditMode(true)}
                        >
                          Edit
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button onClick={cancelEdit}>Cancel</Button>
                        <Button
                          type="primary"
                          icon={<SaveOutlined />}
                          loading={saving}
                          disabled={!client}
                          onClick={saveActiveDocument}
                        >
                          Save
                        </Button>
                      </>
                    )}
                  </Space>
                </div>

                {isEditing ? (
                  <Flex gap={16} align="stretch" style={{ flex: 1, minHeight: 0 }}>
                    <div
                      style={{
                        width: '50%',
                        minWidth: 0,
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <Text strong>Markdown</Text>
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <CodeEditor
                          key={activeDoc.document_id}
                          value={markdownDraft}
                          onChange={setMarkdownDraft}
                          language="markdown"
                          placeholder={'# Page title\n\nWrite markdown here.'}
                          height="100%"
                        />
                      </div>
                    </div>
                    <div
                      style={{
                        width: '50%',
                        minWidth: 0,
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <Text strong>Preview</Text>
                      <div
                        style={{
                          flex: 1,
                          minHeight: 0,
                          overflow: 'auto',
                          padding: 24,
                          border: `1px solid ${token.colorBorderSecondary}`,
                          borderRadius: token.borderRadiusLG,
                          background: token.colorBgContainer,
                        }}
                      >
                        <MarkdownRenderer content={markdownDraft} />
                      </div>
                    </div>
                  </Flex>
                ) : (
                  <div
                    style={{
                      padding: '8px 0 80px',
                      fontSize: 16,
                      lineHeight: 1.7,
                    }}
                  >
                    <MarkdownRenderer
                      content={
                        titleFromContent
                          ? stripFirstMarkdownTitleLine(markdownDraft)
                          : markdownDraft
                      }
                    />
                  </div>
                )}
              </div>
            ) : (
              <Empty
                style={{ paddingTop: 120 }}
                description={
                  selectedFolder
                    ? `Select a page or create one in ${selectedFolder}/.`
                    : 'Select a page or create one in the root folder.'
                }
              />
            )}
          </div>
        </main>
      </Content>

      <Drawer
        title="Version history"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        width="72vw"
        destroyOnHidden
        extra={
          <Space>
            <Segmented
              size="small"
              value={historyView}
              onChange={(value) => setHistoryView(value as 'preview' | 'diff')}
              options={[
                { label: 'Preview', value: 'preview' },
                { label: 'Diff', value: 'diff' },
              ]}
            />
            <Button
              type="primary"
              loading={saving}
              disabled={!selectedVersion || selectedVersion.version_id === versions[0]?.version_id}
              onClick={restoreSelectedVersion}
            >
              Restore
            </Button>
          </Space>
        }
      >
        <Flex gap={16} style={{ height: '100%' }}>
          <div
            style={{
              width: 280,
              flexShrink: 0,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
              paddingRight: 12,
              overflow: 'auto',
            }}
          >
            <List
              dataSource={versions}
              locale={{ emptyText: <Empty description="No version history yet" /> }}
              renderItem={(version, index) => (
                <List.Item
                  onClick={() => setSelectedVersionId(version.version_id)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: token.borderRadiusLG,
                    padding: 12,
                    background:
                      selectedVersion?.version_id === version.version_id
                        ? token.colorPrimaryBg
                        : 'transparent',
                  }}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Text strong>v{version.version_number}</Text>
                        {index === 0 && <Tag color="green">Current</Tag>}
                      </Space>
                    }
                    description={
                      <Space orientation="vertical" size={2}>
                        <Text type="secondary">{formatTimestamp(version.created_at)}</Text>
                        {version.change_summary && <Text>{version.change_summary}</Text>}
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </div>

          <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
            {selectedVersion ? (
              historyView === 'diff' ? (
                previousVersion ? (
                  <DiffBlock
                    filePath={activeDoc?.path ?? 'knowledge.md'}
                    operationType="edit"
                    oldContent={previousVersion.content_text ?? ''}
                    newContent={selectedVersion.content_text ?? ''}
                    forceExpanded
                  />
                ) : (
                  <Empty description="No previous version to diff against" />
                )
              ) : (
                <div style={{ maxWidth: 900, margin: '0 auto', paddingBottom: 80 }}>
                  <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag>v{selectedVersion.version_number}</Tag>
                      <Text type="secondary">{formatTimestamp(selectedVersion.created_at)}</Text>
                    </Space>
                    <MarkdownRenderer content={selectedVersion.content_text ?? ''} />
                  </Space>
                </div>
              )
            ) : (
              <Empty description="Select a version" />
            )}
          </div>
        </Flex>
      </Drawer>

      <Modal
        title="Relocate page"
        open={relocateModalOpen}
        okText="Move"
        onOk={async () => {
          if (activeDoc) await moveDocumentToFolder(activeDoc.document_id, relocateFolder);
          setRelocateModalOpen(false);
        }}
        onCancel={() => setRelocateModalOpen(false)}
        destroyOnHidden
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary">Choose the target folder. The page filename stays the same.</Text>
          <style>
            {`
              .knowledge-relocate-tree .ant-tree-node-content-wrapper,
              .knowledge-relocate-tree .ant-tree-switcher {
                background: transparent !important;
              }
              .knowledge-relocate-tree .ant-tree-node-content-wrapper:hover {
                background: ${token.colorFillQuaternary} !important;
              }
              .knowledge-relocate-tree .ant-tree-node-content-wrapper.ant-tree-node-selected {
                background: ${token.colorPrimaryBg} !important;
                color: ${token.colorPrimaryText} !important;
                font-weight: 600;
              }
              .knowledge-relocate-tree .ant-tree-node-content-wrapper.ant-tree-node-selected:hover {
                background: ${token.colorPrimaryBgHover} !important;
              }
            `}
          </style>
          <Tree
            className="knowledge-relocate-tree"
            showLine
            blockNode
            treeData={relocateTreeData}
            selectedKeys={[`folder:${relocateFolder}`]}
            expandedKeys={expandedTreeKeys}
            onExpand={(keys) => setExpandedTreeKeys(keys)}
            onSelect={(_, info) => {
              const node = info.node as KnowledgeTreeNode;
              if (node.kind === 'folder') setRelocateFolder(node.folderPath ?? ROOT_FOLDER);
            }}
            style={{
              maxHeight: 360,
              overflow: 'auto',
              padding: 8,
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusLG,
              background: token.colorBgContainer,
            }}
          />
        </Space>
      </Modal>

      <Modal
        title={`Create ${kindLabels[createKind] ?? 'Page'}`}
        open={createModalOpen}
        okText="Create"
        confirmLoading={saving}
        onOk={createDocument}
        onCancel={() => setCreateModalOpen(false)}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="Type">
            <Segmented
              block
              value={createKind}
              onChange={(value) => {
                const nextKind = value as KnowledgeDocumentKind;
                const title =
                  nextKind === 'skill'
                    ? 'New Skill'
                    : nextKind === 'memory'
                      ? 'New Memory'
                      : 'New Page';
                setCreateKind(nextKind);
                setCreateTitle(title);
                setCreateFolder(
                  selectedFolder ||
                    (nextKind === 'skill' ? 'skills' : nextKind === 'memory' ? 'memories' : 'pages')
                );
              }}
              options={[
                { label: 'Page', value: 'doc' },
                { label: 'Skill', value: 'skill' },
                { label: 'Memory', value: 'memory' },
              ]}
            />
          </Form.Item>
          <Form.Item label="Space">
            <Select
              value={createNamespace}
              onChange={setCreateNamespace}
              options={namespaces.map((ns) => ({
                label: ns.display_name || ns.slug,
                value: ns.slug,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="Folder"
            validateStatus={createFolderError ? 'error' : undefined}
            help={createFolderError ?? folderNameHelp}
          >
            <AutoComplete
              value={createFolder}
              onChange={(value) => setCreateFolder(normalizeFolderPath(value))}
              options={folderOptions}
              placeholder="Root, pages, skills/how-to, ..."
              filterOption={(input, option) =>
                String(option?.value ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item label="Title">
            <Input
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              autoFocus
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="Path preview"
            description={<Text code>{createPathPreview}</Text>}
          />
        </Form>
      </Modal>

      <Modal
        title="New Folder"
        open={folderModalOpen}
        okText="Create folder"
        onOk={createLocalFolder}
        okButtonProps={{
          disabled:
            !normalizeFolderPath(newFolderName) ||
            Boolean(newFolderNameError || newFolderParentError),
        }}
        onCancel={() => setFolderModalOpen(false)}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item
            label="Parent folder"
            validateStatus={newFolderParentError ? 'error' : undefined}
            help={newFolderParentError ?? folderNameHelp}
          >
            <AutoComplete
              value={newFolderParent}
              onChange={(value) => setNewFolderParent(normalizeFolderPath(value))}
              options={folderOptions}
              placeholder="Root"
              filterOption={(input, option) =>
                String(option?.value ?? '')
                  .toLowerCase()
                  .includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item
            label="Folder name"
            validateStatus={newFolderNameError ? 'error' : undefined}
            help={newFolderNameError ?? folderNameHelp}
          >
            <Input
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              placeholder="research, runbooks, team/data, ..."
              autoFocus
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="Folders are path-based"
            description="Empty folders are local placeholders until you create a page inside them; they still appear in relocate targets."
          />
        </Form>
      </Modal>
    </Layout>
  );
}
