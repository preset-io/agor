import type {
  KnowledgeDocument as CoreKnowledgeDocument,
  KnowledgeIndexingStatus as CoreKnowledgeIndexingStatus,
  KnowledgeNamespace as CoreKnowledgeNamespace,
  KnowledgeDocumentVersion as CoreKnowledgeVersion,
  KnowledgeDocumentKind,
  KnowledgeNamespaceGraph,
  KnowledgeSearchMode,
  KnowledgeSemanticSettingsPublic,
} from '@agor/core/types';
import {
  hasMinimumRole,
  KNOWLEDGE_DOCUMENT_KINDS,
  normalizeKnowledgeFolderPath,
  ROLES,
  titleFromKnowledgeContent,
  validateKnowledgePath as validateSharedKnowledgePath,
} from '@agor/core/types';
import type { AgorClient, User } from '@agor-live/client';
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  DownOutlined,
  EditOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HistoryOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
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
  InputNumber,
  Layout,
  List,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
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
import { ArchiveActionButton } from '../components/ArchiveButton';
import {
  AutocompleteTextarea,
  hydrateKbDocLinks,
  type KbDocMention,
} from '../components/AutocompleteTextarea';
import { BrandLogo } from '../components/BrandLogo';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
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
  mode?: KnowledgeSearchMode;
  chunks?: Array<{ unit_id: string; snippet?: string | null; score?: number }>;
}

type KnowledgeSemanticSettings = KnowledgeSemanticSettingsPublic & { api_key?: string | null };
type KnowledgeIndexingStatus = CoreKnowledgeIndexingStatus;

interface KnowledgePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  /** All known users, keyed by id — powers `@` user mentions in the editor. */
  userById?: Map<string, User>;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

const EMPTY_USER_MAP: Map<string, User> = new Map();

const DEFAULT_MARKDOWN = `# New Knowledge Page\n\nWrite markdown here.\n`;
const DRAFT_DOCUMENT_ID = '__knowledge_draft__' as CoreKnowledgeDocument['document_id'];
const ROOT_FOLDER = '';
const DEFAULT_FOLDERS = ['pages', 'skills', 'memories'];
const DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS: KnowledgeSemanticSettings = {
  enabled: false,
  provider: 'openai',
  model: 'text-embedding-3-small',
  dimensions: 1536,
  api_key_configured: false,
  chunking: {
    target_tokens: 850,
    max_tokens: 1200,
    overlap_tokens: 100,
    min_tokens: 80,
  },
  indexing: {
    paused: false,
    batch_size: 32,
    concurrency: 1,
  },
};

const OPENAI_EMBEDDING_MODEL_OPTIONS = [
  {
    label: 'text-embedding-3-small — recommended',
    value: 'text-embedding-3-small',
  },
  {
    label: 'text-embedding-3-large — higher quality',
    value: 'text-embedding-3-large',
  },
];

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

// Non-throwing slug extraction from a `agor://kb/<slug>/<path>` URI. Unlike
// parseKnowledgeUri (which normalizes/validates the path and throws), this only
// pulls the namespace slug so one malformed doc can't break the mention list.
const namespaceSlugFromUri = (uri?: string | null): string | null => {
  const prefix = 'agor://kb/';
  if (!uri?.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? rest.slice(0, slash) : null;
};

// Non-throwing leaf title used only as a fallback when a doc has no title.
const leafTitleFromPath = (path: string): string => {
  const leaf = path.split('/').filter(Boolean).pop() ?? path;
  return (
    leaf
      .replace(/\.(md|markdown)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || path
  );
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

export function KnowledgePage({
  client,
  currentUser = null,
  userById = EMPTY_USER_MAP,
  onUserSettingsClick,
  onLogout,
}: KnowledgePageProps) {
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
  // All readable docs (across namespaces) for `@` reference autocomplete.
  const [mentionDocs, setMentionDocs] = useState<KbDocMention[]>([]);
  const [draftDocument, setDraftDocument] = useState<KnowledgeDocument | null>(null);
  const [draftNamespaceSlug, setDraftNamespaceSlug] = useState<string | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [activeSpace, setActiveSpace] = useState(() => routeNamespaceSlug ?? 'global');
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  // Whole-Space document graph shown as the home view when no doc is open.
  const [graphData, setGraphData] = useState<KnowledgeNamespaceGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  // Doc hovered in either the tree or the graph, for bidirectional highlighting.
  const [hoverDocId, setHoverDocId] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState(ROOT_FOLDER);
  const [expandedTreeKeys, setExpandedTreeKeys] = useState<React.Key[]>([
    'folder:',
    ...DEFAULT_FOLDERS.map((folder) => `folder:${folder}`),
  ]);
  const [titleDraft, setTitleDraft] = useState('');
  const [visibilityDraft, setVisibilityDraft] = useState<KnowledgeDocument['visibility']>('public');
  const [kindDraft, setKindDraft] = useState<KnowledgeDocumentKind>('doc');
  const [titleFromContent, setTitleFromContent] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState(DEFAULT_MARKDOWN);
  const [searchQuery, setSearchQuery] = useState(() => routeSearchParams.get('q') ?? '');
  const [searchMode, setSearchMode] = useState<KnowledgeSearchMode>('text');
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
  const prevRouteDocPathRef = useRef<string | null>(routeDocumentPath);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const [relocateModalOpen, setRelocateModalOpen] = useState(false);
  const [relocateFolder, setRelocateFolder] = useState(ROOT_FOLDER);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<'preview' | 'diff'>('preview');
  const [titleActionsVisible, setTitleActionsVisible] = useState(false);
  const [renamePathOnTitleChange, setRenamePathOnTitleChange] = useState(false);
  const [knowledgeSettingsOpen, setKnowledgeSettingsOpen] = useState(false);
  const [knowledgeSettings, setKnowledgeSettings] =
    useState<KnowledgeSemanticSettingsPublic | null>(null);
  const [indexingStatus, setIndexingStatus] = useState<KnowledgeIndexingStatus | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsApiKeyDraft, setSettingsApiKeyDraft] = useState('');
  const [settingsForm] = Form.useForm<KnowledgeSemanticSettings>();

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

  // Resolve rename-proof `agor://kb/document/<uuid>` links to clickable links for
  // display. Built from mentionDocs (all docs, not the filtered view) so
  // cross-namespace references hydrate too. Emit absolute same-origin URLs: the
  // markdown renderer's link hardener (rehype-harden) blocks both non-http(s)
  // schemes and relative paths, so a bare route would render as "[blocked]".
  const kbRouteById = useMemo(
    () => new Map<string, string>(mentionDocs.map((doc) => [doc.documentId, doc.routePath])),
    [mentionDocs]
  );
  const hydrateKbLinks = useCallback(
    (markdown: string) =>
      hydrateKbDocLinks(markdown, (id) => {
        const route = kbRouteById.get(id);
        return route ? `${window.location.origin}${route}` : undefined;
      }),
    [kbRouteById]
  );

  // Streamdown renders every link with target="_blank", so a same-origin KB
  // doc link would pop a new tab instead of navigating in-app. Intercept plain
  // left-clicks on internal /kb|/knowledge links and route them through the
  // SPA; modified clicks (cmd/ctrl/shift) keep the native open-in-new-tab.
  const handleKbContentClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement).closest('a');
      const href = anchor?.getAttribute('href');
      if (!href) return;
      let url: URL;
      try {
        url = new URL(href, window.location.origin);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin || !/^\/(kb|knowledge)\//.test(url.pathname)) {
        return;
      }
      event.preventDefault();
      navigate(`${url.pathname}${url.search}${url.hash}`);
    },
    [navigate]
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
            kindDraft !== activeDoc.kind ||
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

  // Load every readable doc (no namespace/kind filter) so `@` can reference
  // docs across spaces. Kept separate from `documents`, which is scoped by the
  // sidebar's active namespace, kind, and search query.
  const loadMentionDocs = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.service('kb/documents').find({ query: { archived: false } });
      const rows = normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[]);
      const mentions = rows.reduce<KbDocMention[]>((acc, doc) => {
        const path = doc.path?.trim();
        if (!path) return acc;
        const slug = namespaceSlugFromUri(doc.uri);
        if (!slug) return acc;
        acc.push({
          title: doc.title?.trim() || leafTitleFromPath(path),
          documentId: doc.document_id,
          path,
          uri: doc.uri,
          routePath: buildKnowledgeRoutePath('/kb', slug, path),
        });
        return acc;
      }, []);
      setMentionDocs(mentions);
    } catch (err) {
      console.error('Failed to load Knowledge mentions:', err);
    }
  }, [client]);

  const loadDocuments = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      await loadNamespaces();
      void loadMentionDocs();
      const kind = kindForSegment(kindFilter);
      const namespaceFilter = activeSpace === 'all' ? undefined : activeSpace;
      if (searchQuery.trim()) {
        const result = await client.service('kb/search').find({
          query: {
            q: searchQuery.trim(),
            namespace_slug: namespaceFilter,
            kind,
            limit: 50,
            mode: searchMode,
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
  }, [client, activeSpace, kindFilter, searchQuery, searchMode, loadNamespaces, loadMentionDocs]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);
  const refreshKnowledgeSettings = useCallback(async () => {
    if (!client) return;
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const [settings, status] = await Promise.all([
        client.service('kb/settings').find(),
        client.service('kb/indexing/status').find(),
      ]);
      const nextSettings = {
        ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS,
        ...(settings as unknown as KnowledgeSemanticSettingsPublic),
        chunking: {
          ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.chunking,
          ...((settings as unknown as KnowledgeSemanticSettingsPublic).chunking ?? {}),
        },
        indexing: {
          ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.indexing,
          ...((settings as unknown as KnowledgeSemanticSettingsPublic).indexing ?? {}),
        },
      };
      setKnowledgeSettings(nextSettings);
      setIndexingStatus(status as unknown as KnowledgeIndexingStatus);
      settingsForm.setFieldsValue(nextSettings);
    } catch (err) {
      console.error('Failed to load Knowledge semantic settings:', err);
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsLoading(false);
    }
  }, [client, settingsForm]);

  const openKnowledgeSettings = useCallback(() => {
    setKnowledgeSettingsOpen(true);
    setSettingsApiKeyDraft('');
    setSettingsError(null);
    void refreshKnowledgeSettings();
  }, [refreshKnowledgeSettings]);

  const saveKnowledgeSettings = useCallback(async () => {
    if (!client) return;
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const values = await settingsForm.validateFields();
      const patch: Record<string, unknown> = {
        enabled: values.enabled ?? DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.enabled,
        provider: values.provider ?? DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.provider,
        model: values.model || DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.model,
        dimensions: values.dimensions ?? DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.dimensions,
        chunking: {
          ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.chunking,
          ...(values.chunking ?? {}),
        },
        indexing: {
          ...DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS.indexing,
          ...(values.indexing ?? {}),
        },
      };
      if (settingsApiKeyDraft.trim()) patch.api_key = settingsApiKeyDraft.trim();
      const next = await client.service('kb/settings').create(patch);
      setKnowledgeSettings(next as KnowledgeSemanticSettingsPublic);
      setSettingsApiKeyDraft('');
      await refreshKnowledgeSettings();
      setKnowledgeSettingsOpen(false);
    } catch (err) {
      console.error('Failed to save Knowledge semantic settings:', err);
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }, [client, refreshKnowledgeSettings, settingsApiKeyDraft, settingsForm]);

  const reindexKnowledge = useCallback(async () => {
    if (!client) return;
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await client.service('kb/indexing/reindex').create({});
      await refreshKnowledgeSettings();
    } catch (err) {
      console.error('Failed to queue Knowledge reindex:', err);
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }, [client, refreshKnowledgeSettings]);

  // The namespace graph is scoped to a single Space; "All Spaces" has no graph.
  const loadGraph = useCallback(async () => {
    if (!client || activeSpace === 'all') {
      setGraphData(null);
      return;
    }
    setGraphLoading(true);
    try {
      const result = await client.service('kb/graph').find({ query: { namespace: activeSpace } });
      setGraphData(result as unknown as KnowledgeNamespaceGraph);
    } catch (err) {
      console.error('Failed to load Knowledge graph:', err);
      setGraphData(null);
    } finally {
      setGraphLoading(false);
    }
  }, [client, activeSpace]);

  // Refresh the graph whenever it becomes the visible view (no doc open), so
  // edges created by a just-saved edit show up on return.
  useEffect(() => {
    if (!activeDocId) loadGraph();
  }, [activeDocId, loadGraph]);

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

    // Only clear when the URL genuinely transitioned away from a document.
    // selectKnowledgeDocument issues setActiveDocId + navigate together; React
    // commits the state before react-router's location updates, so for one
    // render activeDocId is set while routeDocumentPath still lags at ''. Without
    // this transition guard we'd clear activeDocId on that transient render,
    // flashing the graph back before the URL catches up and re-opens the doc.
    const routeDocPathTransitionedAway = !routeDocumentPath && Boolean(prevRouteDocPathRef.current);
    prevRouteDocPathRef.current = routeDocumentPath;

    if (
      routeDocPathTransitionedAway &&
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
      setKindDraft(activeDoc.kind);
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

    // Only an OPEN document drives the URL from this effect. When no doc is
    // open, the namespace portion of the URL is owned solely by the navigation
    // handlers (changeKnowledgeSpace / goToGraphHome) and read back into state
    // by the route-reading effect above. Mirroring `activeSpace` into the URL
    // here as well made the namespace a two-writer value: this effect and the
    // route-reading effect would leapfrog (each acting on the other's
    // pre-commit value), ping-ponging the route between namespaces forever.
    if (!activeDoc) return;

    const targetUrl = `${buildKnowledgeRoutePath(routeBasePath, namespaceSlugForDocument(activeDoc), activeDoc.path)}${buildKnowledgeSearch()}`;
    const currentUrl = `${location.pathname}${location.search}`;
    if (targetUrl !== currentUrl) navigate(targetUrl, { replace: true });
  }, [
    activeDoc,
    activeDocId,
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
    setKindDraft(draft.kind);
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
      } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
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
          kind: kindDraft,
          visibility: visibilityDraft,
          metadata: {
            ...(activeDoc.metadata ?? {}),
            title_from_content: titleFromContent,
          },
          content_text: markdownDraft,
          change_summary: 'Initial version',
        } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
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
        kind: kindDraft,
        ...(nextPath ? { path: nextPath } : {}),
        content_text: markdownDraft,
        metadata: {
          ...(activeDoc.metadata ?? {}),
          title_from_content: titleFromContent,
        },
        change_summary: nextPath
          ? `Edited and renamed from ${activeDoc.path} to ${nextPath}`
          : 'Edited from Knowledge UI',
      } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
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
      } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
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
      setKindDraft('doc');
      setTitleFromContent(false);
      setRenamePathOnTitleChange(false);
      setMarkdownDraft(DEFAULT_MARKDOWN);
      setVersions([]);
      setKnowledgeEditMode(false);
      return;
    }
    setTitleDraft(activeDoc.title);
    setVisibilityDraft(activeDoc.visibility);
    setKindDraft(activeDoc.kind);
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
      } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
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

  const archiveActiveDocument = () => {
    if (!client || !activeDoc) return;
    confirm({
      title: 'Archive this page?',
      content: 'This archives the page from Knowledge. Version history remains in the database.',
      okText: 'Archive',
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
          console.error('Failed to archive Knowledge document:', err);
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

  const goToGraphHome = async () => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    clearDraftDocument();
    activeDocIdRef.current = null;
    setActiveDocId(null);
    pendingEditModeRef.current = false;
    setIsEditing(false);
    const targetPath =
      activeSpace === 'all' ? routeBasePath : buildKnowledgeRoutePath(routeBasePath, activeSpace);
    navigate(`${targetPath}${buildKnowledgeSearch({ editing: false })}`);
  };

  const openGraphDoc = async (documentId: string) => {
    const known = documents.find((doc) => doc.document_id === documentId);
    if (known) {
      await selectKnowledgeDocument(known);
      return;
    }
    // Node is filtered out of the sidebar (kind filter / search). Resolve it
    // from the graph data and clear filters so the routed doc lands in
    // `documents` and the route-resolution effect can open it.
    const node = graphData?.nodes.find((n) => n.document_id === documentId);
    if (!node) return;
    if (!(await confirmDiscardUnsavedChanges())) return;
    clearDraftDocument();
    const slug = namespaceSlugFromUri(node.uri) ?? activeSpace;
    setKindFilter('All');
    setSearchQuery('');
    pendingEditModeRef.current = false;
    setIsEditing(false);
    navigate(buildKnowledgeRoutePath(routeBasePath, slug, node.path));
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

  const renderDocumentRow = (doc: KnowledgeDocument, depth = 0): React.ReactNode => {
    const isActive = activeDoc?.document_id === doc.document_id;
    const isHovered = hoverDocId === doc.document_id;
    return (
      <button
        key={doc.document_id}
        type="button"
        onClick={() => selectKnowledgeDocument(doc)}
        onMouseEnter={() => setHoverDocId(doc.document_id)}
        onMouseLeave={() =>
          setHoverDocId((current) => (current === doc.document_id ? null : current))
        }
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
          background: isActive
            ? token.colorPrimaryBg
            : isHovered
              ? token.colorFillSecondary
              : 'transparent',
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
            fontWeight: isActive ? 600 : 400,
          }}
        >
          {doc.title}
        </span>
      </button>
    );
  };

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
  // Graph is the home view: shown in the main panel whenever no doc is open.
  const showGraph = !activeDoc && !isEditing;
  const fillMain = isEditing || showGraph;

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
          <Text strong style={{ fontSize: 15, cursor: 'pointer' }} onClick={goToGraphHome}>
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
          <Tooltip title="Documentation" placement="bottom">
            <Button
              type="text"
              icon={<QuestionCircleOutlined style={{ fontSize: token.fontSizeLG }} />}
              href="https://agor.live/guide/getting-started"
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            />
          </Tooltip>
          <ThemeSwitcher />
          {hasMinimumRole(currentUser?.role, ROLES.ADMIN) && (
            <Tooltip title="Knowledge settings" placement="bottom">
              <Button
                type="text"
                icon={<SettingOutlined style={{ fontSize: token.fontSizeLG }} />}
                onClick={openKnowledgeSettings}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              />
            </Tooltip>
          )}
          <GlobalUserMenu
            user={currentUser}
            onUserSettingsClick={onUserSettingsClick}
            onLogout={onLogout}
          />
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
            <Segmented
              block
              size="small"
              value={searchMode}
              onChange={(value) => setSearchMode(value as KnowledgeSearchMode)}
              options={[
                { label: 'Text', value: 'text' },
                { label: 'Semantic', value: 'semantic' },
                { label: 'Hybrid', value: 'hybrid' },
              ]}
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
                <button
                  type="button"
                  onClick={goToGraphHome}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 30,
                    margin: '1px 0',
                    padding: '5px 10px',
                    border: 0,
                    borderRadius: token.borderRadius,
                    background: !activeDoc ? token.colorPrimaryBg : 'transparent',
                    color: token.colorText,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontWeight: !activeDoc ? 600 : 400,
                  }}
                >
                  <ApartmentOutlined style={{ color: token.colorTextTertiary, fontSize: 13 }} />
                  <span>Graph</span>
                </button>
                {renderRootContents()}
              </div>
            </Spin>
          </Space>
        </aside>

        <main
          style={{
            flex: 1,
            minWidth: 0,
            overflow: fillMain ? 'hidden' : 'auto',
            background: token.colorBgLayout,
          }}
        >
          <div
            style={{
              maxWidth: fillMain ? 'none' : 1040,
              height: fillMain ? '100%' : undefined,
              margin: fillMain ? 0 : '0 auto',
              padding: showGraph ? 0 : isEditing ? 24 : '40px 56px',
              boxSizing: 'border-box',
              display: fillMain ? 'flex' : undefined,
              flexDirection: fillMain ? 'column' : undefined,
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
                      {isEditing ? (
                        <Select
                          size="small"
                          value={kindDraft}
                          onChange={setKindDraft}
                          style={{ width: 128 }}
                          options={KNOWLEDGE_DOCUMENT_KINDS.map((kind) => ({
                            label: kindLabels[kind],
                            value: kind,
                          }))}
                        />
                      ) : (
                        <Tag>{kindLabels[activeDoc.kind] ?? activeDoc.kind}</Tag>
                      )}
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
                            <ArchiveActionButton
                              tooltip=""
                              size="middle"
                              disabled={!client}
                              onClick={archiveActiveDocument}
                            >
                              Archive
                            </ArchiveActionButton>
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
                      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                        <AutocompleteTextarea
                          key={activeDoc.document_id}
                          value={markdownDraft}
                          onChange={setMarkdownDraft}
                          client={client}
                          sessionId={null}
                          userById={userById}
                          kbDocs={mentionDocs}
                          placeholder={
                            '# Page title\n\nWrite markdown here. Type @ to link a doc or mention a user, : for emoji.'
                          }
                          autoSize={{ minRows: 24 }}
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
                        onClick={handleKbContentClick}
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
                        <MarkdownRenderer content={hydrateKbLinks(markdownDraft)} />
                      </div>
                    </div>
                  </Flex>
                ) : (
                  <div
                    onClick={handleKbContentClick}
                    style={{
                      padding: '8px 0 80px',
                      fontSize: 16,
                      lineHeight: 1.7,
                    }}
                  >
                    <MarkdownRenderer
                      content={hydrateKbLinks(
                        titleFromContent
                          ? stripFirstMarkdownTitleLine(markdownDraft)
                          : markdownDraft
                      )}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, width: '100%' }}>
                <KnowledgeGraph
                  nodes={graphData?.nodes ?? []}
                  edges={graphData?.edges ?? []}
                  activeDocId={activeDocId}
                  hoverDocId={hoverDocId}
                  onSelectDoc={openGraphDoc}
                  onHoverDoc={setHoverDocId}
                  loading={graphLoading}
                  emptyText={
                    activeSpace === 'all'
                      ? 'Pick a Space to see its document graph.'
                      : 'No linked documents in this Space yet.'
                  }
                />
              </div>
            )}
          </div>
        </main>
      </Content>

      <Drawer
        title="Version history"
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        size="72vw"
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
                <div
                  onClick={handleKbContentClick}
                  style={{ maxWidth: 900, margin: '0 auto', paddingBottom: 80 }}
                >
                  <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                    <Space wrap>
                      <Tag>v{selectedVersion.version_number}</Tag>
                      <Text type="secondary">{formatTimestamp(selectedVersion.created_at)}</Text>
                    </Space>
                    <MarkdownRenderer
                      content={hydrateKbLinks(selectedVersion.content_text ?? '')}
                    />
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
        title="Knowledge semantic search"
        open={knowledgeSettingsOpen}
        onCancel={() => setKnowledgeSettingsOpen(false)}
        okText="Save settings"
        onOk={saveKnowledgeSettings}
        confirmLoading={settingsSaving}
        width={720}
      >
        <Spin spinning={settingsLoading}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {settingsError && <Alert type="error" showIcon message={settingsError} />}
            <Alert
              type="info"
              showIcon
              message="Semantic search uses markdown-aware chunks stored in Postgres/pgvector. SQLite can save settings and chunks, but vector search requires Postgres."
            />
            {indexingStatus && (
              <div
                style={{
                  border: `1px solid ${token.colorBorderSecondary}`,
                  borderRadius: token.borderRadiusLG,
                  padding: 12,
                  background: token.colorFillQuaternary,
                }}
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Text strong>Indexing status</Text>
                  <Text type="secondary">
                    {indexingStatus.dialect} · pgvector{' '}
                    {indexingStatus.pgvector_available
                      ? 'ready'
                      : indexingStatus.pgvector_extension_installed
                        ? 'extension installed, storage not ready'
                        : 'not available'}{' '}
                    · queue {indexingStatus.queue_depth}
                  </Text>
                  <Space wrap>
                    {Object.entries(indexingStatus.chunks).map(([status, count]) => (
                      <Tag key={status}>
                        {status}: {Number(count)}
                      </Tag>
                    ))}
                  </Space>
                  {indexingStatus.last_error && (
                    <Alert type="warning" message={indexingStatus.last_error} />
                  )}
                </Space>
              </div>
            )}
            <Form
              form={settingsForm}
              layout="vertical"
              initialValues={knowledgeSettings ?? DEFAULT_KNOWLEDGE_SEMANTIC_SETTINGS}
            >
              <Form.Item
                name="enabled"
                label="Enable semantic / hybrid search"
                valuePropName="checked"
              >
                <Switch />
              </Form.Item>
              <Flex gap={12} wrap="wrap">
                <Form.Item name="provider" label="Provider" style={{ minWidth: 180, flex: 1 }}>
                  <Select options={[{ label: 'OpenAI', value: 'openai' }]} />
                </Form.Item>
                <Form.Item name="model" label="Model" style={{ minWidth: 240, flex: 2 }}>
                  <Select
                    options={OPENAI_EMBEDDING_MODEL_OPTIONS}
                    onChange={() => settingsForm.setFieldValue('dimensions', 1536)}
                  />
                </Form.Item>
                <Form.Item
                  name="dimensions"
                  label="Dimensions"
                  tooltip="Agor V1 indexes 1536-dimensional embeddings. text-embedding-3-large is requested with dimensions=1536."
                  style={{ width: 140 }}
                >
                  <InputNumber
                    disabled
                    min={1536}
                    max={1536}
                    precision={0}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              </Flex>
              <Form.Item label="OpenAI API key">
                <Input.Password
                  value={settingsApiKeyDraft}
                  onChange={(event) => setSettingsApiKeyDraft(event.target.value)}
                  placeholder={
                    knowledgeSettings?.api_key_configured
                      ? 'Configured — enter a new key to replace'
                      : 'sk-...'
                  }
                  autoComplete="off"
                />
              </Form.Item>
              <Flex gap={12} wrap="wrap">
                <Form.Item
                  name={['chunking', 'target_tokens']}
                  label="Target tokens"
                  style={{ width: 150 }}
                >
                  <InputNumber min={100} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['chunking', 'max_tokens']}
                  label="Max tokens"
                  style={{ width: 150 }}
                >
                  <InputNumber min={100} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['chunking', 'overlap_tokens']}
                  label="Overlap"
                  style={{ width: 130 }}
                >
                  <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['chunking', 'min_tokens']}
                  label="Min tokens"
                  style={{ width: 130 }}
                >
                  <InputNumber min={0} precision={0} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name={['indexing', 'batch_size']}
                  label="Batch size"
                  style={{ width: 130 }}
                >
                  <InputNumber min={1} max={256} precision={0} style={{ width: '100%' }} />
                </Form.Item>
              </Flex>
            </Form>
            <Flex justify="space-between" align="center">
              <Text type="secondary">
                Reindexing queues current Knowledge chunks and wakes the background indexer.
              </Text>
              <Button onClick={reindexKnowledge} loading={settingsSaving}>
                Reindex now
              </Button>
            </Flex>
          </Space>
        </Spin>
      </Modal>

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
