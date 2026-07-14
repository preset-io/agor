import type {
  KnowledgeDocument as CoreKnowledgeDocument,
  KnowledgeIndexingStatus as CoreKnowledgeIndexingStatus,
  KnowledgeNamespace as CoreKnowledgeNamespace,
  KnowledgeNamespaceAclEntry as CoreKnowledgeNamespaceAclEntry,
  KnowledgeDocumentVersion as CoreKnowledgeVersion,
  KnowledgeDocumentIndexingStatus,
  KnowledgeDocumentKind,
  KnowledgeDocumentStatus,
  KnowledgeNamespaceGraph,
  KnowledgeNamespacePermission,
  KnowledgeNamespaceSubjectType,
  KnowledgeSearchMode,
  KnowledgeSemanticSettingsPublic,
} from '@agor/core/types';
import {
  hasMinimumRole,
  KNOWLEDGE_DOCUMENT_KINDS,
  normalizeKnowledgeDocumentIconEmoji,
  normalizeKnowledgeFolderPath,
  ROLES,
  titleFromKnowledgeContent,
  validateKnowledgePath as validateSharedKnowledgePath,
} from '@agor/core/types';
import type { AgorClient, Group, User } from '@agor-live/client';
import {
  ApartmentOutlined,
  ArrowLeftOutlined,
  BulbOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HistoryOutlined,
  LoadingOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UpOutlined,
  UserOutlined,
  WarningOutlined,
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
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Tree,
  Typography,
  theme,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from 'react-resizable-panels';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArchiveActionButton } from '../components/ArchiveButton';
import {
  AutocompleteTextarea,
  hydrateKbDocLinks,
  type KbDocMention,
  kbMentionFromDocument,
} from '../components/AutocompleteTextarea';
import { BrandLogo } from '../components/BrandLogo';
import { AgorEmojiPicker } from '../components/EmojiPickerInput';
import { GlobalUserMenu } from '../components/GlobalUserMenu';
import { HighlightMatch } from '../components/HighlightMatch';
import { KnowledgeGraph } from '../components/KnowledgeGraph';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { DiffBlock } from '../components/ToolUseRenderer/renderers/DiffBlock';
import { useUserLocalStorage } from '../hooks/useUserLocalStorage';
import { useAgorStore } from '../store/agorStore';
import { selectUserById } from '../store/selectors';
import {
  buildKnowledgeRoutePath,
  decodeKnowledgeRoutePath,
  getKnowledgeRouteBase,
  namespaceSlugFromUri,
  safeDecodeURIComponent,
} from '../utils/knowledgeRoutes';
import { useThemedModal } from '../utils/modal';
import { slugify } from '../utils/repoSlug';
import { searchableSelectProps } from '../utils/selectSearch';

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

interface KnowledgeEmbeddingReuseIntoNext {
  targetVersionId: string;
  embeddingSpaceId?: string;
  provider?: string;
  model?: string;
  dimensions?: number;
  reusedChunks: number;
  totalChunks: number;
  updatedAt?: string;
}

type KnowledgeSemanticSettings = KnowledgeSemanticSettingsPublic & { api_key?: string | null };

type KnowledgeNamespaceAclEntry = Pick<
  CoreKnowledgeNamespaceAclEntry,
  'namespace_acl_id' | 'namespace_id' | 'subject_type' | 'subject_id' | 'permission'
>;

interface KnowledgeNamespaceAclDraftEntry {
  subject_type: KnowledgeNamespaceSubjectType;
  subject_id: string;
  permission: KnowledgeNamespacePermission;
}

interface RouteDocumentResolutionFailure {
  key: string;
  message: string;
}

type KnowledgeNamespaceFormValues = Pick<
  KnowledgeNamespace,
  'slug' | 'display_name' | 'description' | 'kind' | 'visibility_default' | 'others_can'
>;
type KnowledgeIndexingStatus = CoreKnowledgeIndexingStatus;

type KnowledgeNamespacesClientService = ReturnType<AgorClient['service']> & {
  listAcl(data: { namespace_id: string }): Promise<KnowledgeNamespaceAclEntry[]>;
  saveWithAcl(data: {
    namespace_id?: string;
    namespace: Partial<KnowledgeNamespace>;
    acl: KnowledgeNamespaceAclDraftEntry[];
  }): Promise<{ namespace: KnowledgeNamespace; acl: KnowledgeNamespaceAclEntry[] }>;
};

type KnowledgeNamespacesClientServiceWithMethods = KnowledgeNamespacesClientService & {
  methods?: (...names: string[]) => unknown;
  __knowledgeNamespaceMethodsRegistered?: boolean;
};

interface KnowledgePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  onUserSettingsClick?: () => void;
  onLogout?: () => void;
}

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

const KNOWLEDGE_SIDEBAR_MIN_WIDTH_PX = 280;
const KNOWLEDGE_SIDEBAR_MAX_WIDTH_PX = 780;
const KNOWLEDGE_SIDEBAR_DEFAULT_SIZE_PERCENT = 24;
const KNOWLEDGE_SIDEBAR_MAX_SIZE_PERCENT = 60;

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const widthToPercent = (widthPx: number, viewportWidth: number) =>
  (widthPx / Math.max(viewportWidth, 1)) * 100;

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

const indexingStateMeta: Record<
  KnowledgeDocumentIndexingStatus['state'],
  {
    label: string;
    colorToken: 'colorTextSecondary' | 'colorInfo' | 'colorSuccess' | 'colorWarning' | 'colorError';
    tooltip: string;
  }
> = {
  empty: {
    label: 'No semantic index',
    colorToken: 'colorTextSecondary',
    tooltip: 'No indexable units exist for the current version yet.',
  },
  not_configured: {
    label: 'Semantic indexing unavailable',
    colorToken: 'colorTextSecondary',
    tooltip: 'Semantic indexing is not configured for these chunks.',
  },
  queued: {
    label: 'Indexing',
    colorToken: 'colorInfo',
    tooltip: 'Some chunks are queued for semantic indexing.',
  },
  ready: {
    label: 'Semantic index ready',
    colorToken: 'colorSuccess',
    tooltip: 'Current chunks are available for semantic search.',
  },
  stale: {
    label: 'Needs semantic refresh',
    colorToken: 'colorWarning',
    tooltip: 'Some chunks are stale and need semantic index refresh.',
  },
  error: {
    label: 'Semantic index error',
    colorToken: 'colorError',
    tooltip: 'At least one chunk failed semantic indexing.',
  },
  mixed: {
    label: 'Partial semantic index',
    colorToken: 'colorInfo',
    tooltip: 'Chunks have mixed semantic indexing states.',
  },
};

const indexingChunkLabels: Record<string, string> = {
  not_configured: 'not configured',
  pending: 'queued',
  ready: 'ready',
  stale: 'stale',
  error: 'error',
};

function indexingTooltip(status: KnowledgeDocumentIndexingStatus): string {
  const counts = Object.entries(status.chunks)
    .filter(([, count]) => Number(count) > 0)
    .map(([state, count]) => `${indexingChunkLabels[state] ?? state}: ${count}`)
    .join(', ');
  const model = status.embedding_model ? ` · ${status.embedding_model}` : '';
  const queue = status.queue_depth > 0 ? ` · queue ${status.queue_depth}` : '';
  const error = status.last_error ? ` · ${status.last_error}` : '';
  return `${indexingStateMeta[status.state].tooltip}${model}${queue}${counts ? ` · ${counts}` : ''}${error}`;
}

function shouldShowIndexingCue(status?: KnowledgeDocumentIndexingStatus | null): boolean {
  return Boolean(status && status.state !== 'empty' && status.state !== 'not_configured');
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function embeddingReuseIntoNext(version: KnowledgeVersion): KnowledgeEmbeddingReuseIntoNext | null {
  const metadata = metadataRecord(version.metadata);
  const reuse = metadataRecord(metadata?.embedding_reuse_into_next);
  if (!reuse) return null;
  const reusedChunks = Number(reuse.reused_chunks);
  const totalChunks = Number(reuse.total_chunks);
  if (!Number.isFinite(reusedChunks) || !Number.isFinite(totalChunks) || totalChunks <= 0) {
    return null;
  }
  return {
    targetVersionId: String(reuse.target_version_id ?? ''),
    embeddingSpaceId: reuse.embedding_space_id ? String(reuse.embedding_space_id) : undefined,
    provider: reuse.provider ? String(reuse.provider) : undefined,
    model: reuse.model ? String(reuse.model) : undefined,
    dimensions: Number.isFinite(Number(reuse.dimensions)) ? Number(reuse.dimensions) : undefined,
    reusedChunks,
    totalChunks,
    updatedAt: reuse.updated_at ? String(reuse.updated_at) : undefined,
  };
}

function IndexingStatusCue({
  status,
  size = 14,
}: {
  status?: KnowledgeDocumentIndexingStatus | null;
  size?: number;
}) {
  const { token } = theme.useToken();
  if (!shouldShowIndexingCue(status) || !status) return null;

  const meta = indexingStateMeta[status.state];
  const iconStyle = { color: token[meta.colorToken], fontSize: size };
  const icon =
    status.state === 'queued' ? (
      <LoadingOutlined spin style={iconStyle} />
    ) : status.state === 'error' ? (
      <WarningOutlined style={iconStyle} />
    ) : (
      <ExperimentOutlined style={iconStyle} />
    );

  return (
    <Tooltip title={indexingTooltip(status)}>
      <span
        aria-label={meta.label}
        role="img"
        style={{
          alignItems: 'center',
          display: 'inline-flex',
          flex: '0 0 auto',
          height: size + 2,
          justifyContent: 'center',
          lineHeight: 1,
          width: size + 2,
        }}
      >
        {icon}
      </span>
    </Tooltip>
  );
}

const kindForSegment = (segment: string): KnowledgeDocumentKind | undefined => {
  if (segment === 'Pages') return 'doc';
  if (segment === 'Skills') return 'skill';
  if (segment === 'Memories') return 'memory';
  return undefined;
};

const normalizeFindResult = <T,>(result: T[] | { data?: T[] }): T[] =>
  Array.isArray(result) ? result : (result.data ?? []);

const getKnowledgeNamespacesService = (client: AgorClient): KnowledgeNamespacesClientService => {
  const service = client.service(
    'kb/namespaces'
  ) as unknown as KnowledgeNamespacesClientServiceWithMethods;
  if (!service.__knowledgeNamespaceMethodsRegistered) {
    service.methods?.('listAcl', 'setAcl', 'removeAcl', 'saveWithAcl');
    service.__knowledgeNamespaceMethodsRegistered = true;
  }
  return service;
};

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

export function resolveActiveKnowledgeDocument<T extends { document_id: string }>(args: {
  activeDocId: string | null;
  draftDocument: T | null;
  documents: T[];
  activeDocSnapshot: T | null;
}): T | null {
  const { activeDocId, activeDocSnapshot, documents, draftDocument } = args;
  if (activeDocId === DRAFT_DOCUMENT_ID) return draftDocument;
  if (!activeDocId) return null;

  return (
    documents.find((doc) => doc.document_id === activeDocId) ??
    (activeDocSnapshot?.document_id === activeDocId ? activeDocSnapshot : null)
  );
}

export function shouldDeferKnowledgeUrlMirrorForRoute(args: {
  routeDocumentPath: string;
  activeDocPath?: string | null;
}): boolean {
  return Boolean(args.routeDocumentPath && args.activeDocPath !== args.routeDocumentPath);
}

export function shouldShowKnowledgeRouteDocumentLoading(args: {
  activeDocMatchesRoute: boolean;
  routeDocumentResolutionFailed: boolean;
  routeNamespaceSlug?: string | null;
  routeDocumentPath: string;
}): boolean {
  return Boolean(
    args.routeNamespaceSlug &&
      args.routeDocumentPath &&
      !args.activeDocMatchesRoute &&
      !args.routeDocumentResolutionFailed
  );
}

export function shouldShowKnowledgeGraphView(args: {
  activeDocPresent: boolean;
  isEditing: boolean;
  routeDocumentPath: string;
}): boolean {
  return !args.activeDocPresent && !args.isEditing && !args.routeDocumentPath;
}

export function isKnowledgeDocumentContentReady(args: {
  activeDocId?: string | null;
  activeDocDocumentId?: string | null;
  isDraftDocument: boolean;
  versionsDocumentId?: string | null;
}): boolean {
  return Boolean(
    args.activeDocDocumentId &&
      (args.isDraftDocument ||
        (args.versionsDocumentId === args.activeDocDocumentId &&
          args.activeDocDocumentId === args.activeDocId))
  );
}

export function buildKnowledgeQueryString(args: {
  query?: string;
  editing?: boolean;
  activeDocId?: string | null;
}): string {
  const params = new URLSearchParams();

  if (args.query?.trim()) params.set('q', args.query.trim());
  if (args.editing && args.activeDocId === DRAFT_DOCUMENT_ID) params.set('draft', 'page');
  if (args.editing && args.activeDocId) params.set('mode', 'edit');

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function buildKnowledgeDocumentRouteUrl(args: {
  routeBasePath: string;
  namespaceSlug: string;
  documentPath: string;
  currentSearch?: string;
}): string {
  const currentParams = new URLSearchParams(args.currentSearch ?? '');
  currentParams.delete('kind');
  const search = currentParams.toString();
  return `${buildKnowledgeRoutePath(args.routeBasePath, args.namespaceSlug, args.documentPath)}${
    search ? `?${search}` : ''
  }`;
}

export function matchesKnowledgeSidebarFilter(
  values: Array<string | null | undefined>,
  query: string
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  const haystack = values
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n')
    .toLowerCase();
  if (!haystack) return false;
  if (haystack.includes(normalizedQuery)) return true;

  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return terms.length > 0 && terms.every((term) => haystack.includes(term));
}

export const buildKnowledgeSearchResultKey = (query: string, mode: KnowledgeSearchMode) =>
  `${mode}:${query.trim().toLowerCase()}`;

export const areKnowledgeSearchResultsFresh = (args: {
  resultKey: string | null;
  query: string;
  mode: KnowledgeSearchMode;
}) =>
  Boolean(args.query.trim()) &&
  args.resultKey === buildKnowledgeSearchResultKey(args.query, args.mode);

type KnowledgeNamespaceOptionSource = Pick<
  KnowledgeNamespace,
  'namespace_id' | 'slug' | 'display_name'
>;

const knowledgeNamespaceDisplayName = (namespace: KnowledgeNamespaceOptionSource) =>
  namespace.display_name?.trim() || namespace.slug;

export function resolveKnowledgeSpaceAfterNamespacesLoad(
  activeSpace: string,
  namespaces: KnowledgeNamespaceOptionSource[]
) {
  if (activeSpace === 'all' || namespaces.some((ns) => ns.slug === activeSpace)) {
    return activeSpace;
  }
  return namespaces.find((ns) => ns.slug === 'global')?.slug ?? namespaces[0]?.slug ?? 'global';
}

export function resolveKnowledgeSpaceAfterRouteOrNamespacesLoad(args: {
  activeSpace: string;
  routeNamespaceSlug?: string | null;
  namespaces: KnowledgeNamespaceOptionSource[];
}): string {
  if (args.routeNamespaceSlug) return args.routeNamespaceSlug;
  return resolveKnowledgeSpaceAfterNamespacesLoad(args.activeSpace, args.namespaces);
}

export function isKnowledgeDocumentsResponseCurrent(args: {
  requestId: number;
  currentRequestId: number;
  requestedActiveSpace: string;
  currentActiveSpace: string;
  requestedKindFilter: string;
  currentKindFilter: string;
}): boolean {
  return (
    args.requestId === args.currentRequestId &&
    args.requestedActiveSpace === args.currentActiveSpace &&
    args.requestedKindFilter === args.currentKindFilter
  );
}

export function buildKnowledgeNamespaceSelectOptions(namespaces: KnowledgeNamespaceOptionSource[]) {
  return [...namespaces]
    .sort((a, b) => {
      const displayCompare = knowledgeNamespaceDisplayName(a).localeCompare(
        knowledgeNamespaceDisplayName(b),
        undefined,
        { sensitivity: 'base', numeric: true }
      );
      if (displayCompare !== 0) return displayCompare;

      const slugCompare = a.slug.localeCompare(b.slug, undefined, {
        sensitivity: 'base',
        numeric: true,
      });
      if (slugCompare !== 0) return slugCompare;

      return a.namespace_id.localeCompare(b.namespace_id);
    })
    .map((namespace) => {
      const label = knowledgeNamespaceDisplayName(namespace);
      return {
        label,
        value: namespace.slug,
        searchText: `${label} ${namespace.slug}`.toLowerCase(),
      };
    });
}

const compactKnowledgeSnippet = (value?: string | null) =>
  (value ?? '')
    .replace(/[`*_#>[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

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

const encodeNamespaceSubjectValue = (
  subjectType: KnowledgeNamespaceSubjectType,
  subjectId: string
) => `${subjectType}:${subjectId}`;

const parseNamespaceSubjectValue = (
  value?: string | null
): { subjectType: KnowledgeNamespaceSubjectType; subjectId: string } | null => {
  if (!value) return null;
  const [subjectType, ...rest] = value.split(':');
  const subjectId = rest.join(':');
  if ((subjectType !== 'user' && subjectType !== 'group') || !subjectId) return null;
  return { subjectType, subjectId };
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
  onUserSettingsClick,
  onLogout,
}: KnowledgePageProps) {
  // Self-subscribe to the user map (powers `@` user mentions). The subscription
  // used to live in the outer App shell; relocating it here keeps the shell from
  // re-rendering on every user write.
  const userById = useAgorStore(selectUserById);
  const { token } = theme.useToken();
  const { confirm } = useThemedModal();
  const navigate = useNavigate();
  const location = useLocation();
  const routeParams = useParams<{ namespaceSlug?: string; '*'?: string }>();
  const routeNamespaceSlug = routeParams.namespaceSlug
    ? safeDecodeURIComponent(routeParams.namespaceSlug)
    : null;
  const routeDocumentPath = decodeKnowledgeRoutePath(routeParams['*']);
  const routeDocumentKey =
    routeNamespaceSlug && routeDocumentPath ? `${routeNamespaceSlug}\n${routeDocumentPath}` : null;
  const routeBasePath = getKnowledgeRouteBase(location.pathname);
  const routeSearchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const [namespaces, setNamespaces] = useState<KnowledgeNamespace[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  // All readable docs (across namespaces) for `@` reference autocomplete.
  const [mentionDocs, setMentionDocs] = useState<KbDocMention[]>([]);
  const [draftDocument, setDraftDocument] = useState<KnowledgeDocument | null>(null);
  const [draftNamespaceSlug, setDraftNamespaceSlug] = useState<string | null>(null);
  const [versions, setVersions] = useState<KnowledgeVersion[]>([]);
  const [versionsDocumentId, setVersionsDocumentId] = useState<string | null>(null);
  const [routeDocumentResolutionFailure, setRouteDocumentResolutionFailure] =
    useState<RouteDocumentResolutionFailure | null>(null);
  const [activeSpace, setActiveSpace] = useState(() => routeNamespaceSlug ?? 'global');
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  // Keep the open document independent from the filtered sidebar result set.
  // The type switcher intentionally filters the tree only; a direct/open doc
  // remains stable even when its kind is outside the current filter.
  const [activeDocSnapshot, setActiveDocSnapshot] = useState<KnowledgeDocument | null>(null);
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
  const [statusDraft, setStatusDraft] = useState<KnowledgeDocumentStatus>('published');
  const [kindDraft, setKindDraft] = useState<KnowledgeDocumentKind>('doc');
  const [iconEmojiDraft, setIconEmojiDraft] = useState<string | null>(null);
  const [titleFromContent, setTitleFromContent] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState(DEFAULT_MARKDOWN);
  const [sidebarFilterQuery, setSidebarFilterQuery] = useState('');
  const [globalSearchQuery, setGlobalSearchQuery] = useState(
    () => routeSearchParams.get('q') ?? ''
  );
  const [globalSearchMode, setGlobalSearchMode] = useState<KnowledgeSearchMode>('text');
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchError, setGlobalSearchError] = useState<string | null>(null);
  const [globalSearchResults, setGlobalSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [globalSearchResultsKey, setGlobalSearchResultsKey] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>('All');
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
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
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
  const [namespaceEditorOpen, setNamespaceEditorOpen] = useState(false);
  const [namespaceEditing, setNamespaceEditing] = useState<KnowledgeNamespace | null>(null);
  const [namespaceSaving, setNamespaceSaving] = useState(false);
  const [namespaceError, setNamespaceError] = useState<string | null>(null);
  const [namespaceForm] = Form.useForm<KnowledgeNamespaceFormValues>();
  const namespaceSlugEditedRef = useRef(false);
  const [namespaceUsers, setNamespaceUsers] = useState<User[]>([]);
  const [namespaceGroups, setNamespaceGroups] = useState<Group[]>([]);
  const [namespaceAclDraft, setNamespaceAclDraft] = useState<KnowledgeNamespaceAclDraftEntry[]>([]);
  const [namespaceAclLoading, setNamespaceAclLoading] = useState(false);
  const [namespaceAclSubject, setNamespaceAclSubject] = useState<string | null>(null);
  const [namespaceAclPermission, setNamespaceAclPermission] =
    useState<KnowledgeNamespacePermission>('read');
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth
  );
  const [sidebarSize, setSidebarSize] = useUserLocalStorage<number>(
    currentUser?.user_id,
    'knowledge:sidebar:size',
    KNOWLEDGE_SIDEBAR_DEFAULT_SIZE_PERCENT
  );
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarResizeDraggingRef = useRef(false);
  const globalSearchContainerRef = useRef<HTMLDivElement>(null);
  const documentsRequestSeqRef = useRef(0);
  const activeSpaceRef = useRef(activeSpace);
  const kindFilterRef = useRef(kindFilter);
  const graphRequestSeqRef = useRef(0);
  const updateActiveSpace = useCallback((space: string) => {
    activeSpaceRef.current = space;
    setActiveSpace(space);
  }, []);
  const updateKindFilter = useCallback((filter: string) => {
    kindFilterRef.current = filter;
    setKindFilter(filter);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!globalSearchOpen || typeof document === 'undefined') return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && globalSearchContainerRef.current?.contains(target)) return;
      setGlobalSearchOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [globalSearchOpen]);

  useEffect(() => {
    setRouteDocumentResolutionFailure((current) =>
      current && current.key !== routeDocumentKey ? null : current
    );
  }, [routeDocumentKey]);

  useEffect(() => {
    activeDocIdRef.current = activeDocId;
  }, [activeDocId]);

  useEffect(() => {
    activeSpaceRef.current = activeSpace;
  }, [activeSpace]);

  useEffect(() => {
    kindFilterRef.current = kindFilter;
  }, [kindFilter]);

  const activeDoc = useMemo(
    () =>
      resolveActiveKnowledgeDocument({
        activeDocId,
        activeDocSnapshot,
        documents,
        draftDocument,
      }),
    [activeDocId, activeDocSnapshot, documents, draftDocument]
  );
  const isDraftDocument = activeDoc?.document_id === DRAFT_DOCUMENT_ID;
  const activeDocIconEmoji = activeDoc ? (isEditing ? iconEmojiDraft : activeDoc.icon_emoji) : null;
  const activeDocContentReady = isKnowledgeDocumentContentReady({
    activeDocId,
    activeDocDocumentId: activeDoc?.document_id,
    isDraftDocument,
    versionsDocumentId,
  });

  const selectedNamespace = useMemo(
    () => namespaces.find((ns) => ns.slug === activeSpace) ?? namespaces[0] ?? null,
    [namespaces, activeSpace]
  );

  const sidebarMinSize = useMemo(
    () =>
      Math.min(
        KNOWLEDGE_SIDEBAR_MAX_SIZE_PERCENT,
        widthToPercent(KNOWLEDGE_SIDEBAR_MIN_WIDTH_PX, viewportWidth)
      ),
    [viewportWidth]
  );
  const sidebarMaxSize = useMemo(
    () =>
      Math.max(
        sidebarMinSize,
        Math.min(
          KNOWLEDGE_SIDEBAR_MAX_SIZE_PERCENT,
          widthToPercent(KNOWLEDGE_SIDEBAR_MAX_WIDTH_PX, viewportWidth)
        )
      ),
    [sidebarMinSize, viewportWidth]
  );
  const effectiveSidebarSize = clampPercent(sidebarSize, sidebarMinSize, sidebarMaxSize);

  useEffect(() => {
    sidebarPanelRef.current?.resize(effectiveSidebarSize);
  }, [effectiveSidebarSize]);

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

  const namespaceAclSubjectOptions = useMemo(() => {
    const users = new Map(userById);
    for (const user of namespaceUsers) users.set(user.user_id, user);
    if (currentUser) users.set(currentUser.user_id, currentUser);
    return [
      {
        label: 'Users',
        options: [...users.values()]
          .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
          .map((user) => ({
            label: `${user.name || user.email}${user.email ? ` <${user.email}>` : ''}`,
            value: encodeNamespaceSubjectValue('user', user.user_id),
          })),
      },
      {
        label: 'Groups',
        options: namespaceGroups
          .filter((group) => !group.archived)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((group) => ({
            label: `${group.name} group`,
            value: encodeNamespaceSubjectValue('group', group.group_id),
          })),
      },
    ];
  }, [currentUser, namespaceGroups, namespaceUsers, userById]);

  const namespaceUserById = useMemo(() => {
    const users = new Map(userById);
    for (const user of namespaceUsers) users.set(user.user_id, user);
    if (currentUser) users.set(currentUser.user_id, currentUser);
    return users;
  }, [currentUser, namespaceUsers, userById]);

  const namespaceSubjectLabel = useCallback(
    (entry: KnowledgeNamespaceAclDraftEntry) => {
      if (entry.subject_type === 'user') {
        const user = namespaceUserById.get(entry.subject_id);
        return user
          ? `${user.name || user.email}${user.email ? ` <${user.email}>` : ''}`
          : entry.subject_id;
      }
      const group = namespaceGroups.find((item) => item.group_id === entry.subject_id);
      return group ? `${group.name} group` : entry.subject_id;
    },
    [namespaceGroups, namespaceUserById]
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
    (overrides: { query?: string; editing?: boolean } = {}) =>
      buildKnowledgeQueryString({
        query: overrides.query,
        editing: overrides.editing ?? isEditing,
        activeDocId,
      }),
    [activeDocId, isEditing]
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
            (iconEmojiDraft ?? null) !== (activeDoc.icon_emoji ?? null) ||
            visibilityDraft !== activeDoc.visibility ||
            statusDraft !== activeDoc.status ||
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
    if (!client) return [];
    const result = await client.service('kb/namespaces').find({ query: { archived: false } });
    const rows = normalizeFindResult<KnowledgeNamespace>(result as KnowledgeNamespace[]);
    setNamespaces(rows);
    return rows;
  }, [client]);

  // Load every readable doc (no namespace/kind filter) so `@` can reference
  // docs across spaces. Kept separate from `documents`, which is scoped by the
  // sidebar's active namespace and kind. The sidebar text box is only a client-side quick-filter.
  const loadMentionDocs = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.service('kb/documents').find({ query: { archived: false } });
      const rows = normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[]);
      const mentions = rows
        .map((doc) => kbMentionFromDocument(doc, '/kb'))
        .filter((doc): doc is KbDocMention => Boolean(doc));
      setMentionDocs(mentions);
    } catch (err) {
      console.error('Failed to load Knowledge mentions:', err);
    }
  }, [client]);

  const loadDocuments = useCallback(async () => {
    if (!client) return;
    const requestId = documentsRequestSeqRef.current + 1;
    documentsRequestSeqRef.current = requestId;
    const requestedActiveSpace = activeSpace;
    const requestedKindFilter = kindFilter;
    const isCurrent = () =>
      isKnowledgeDocumentsResponseCurrent({
        requestId,
        currentRequestId: documentsRequestSeqRef.current,
        requestedActiveSpace,
        currentActiveSpace: activeSpaceRef.current,
        requestedKindFilter,
        currentKindFilter: kindFilterRef.current,
      });

    setLoading(true);
    setError(null);
    try {
      await loadNamespaces();
      if (!isCurrent()) return;
      void loadMentionDocs();
      const kind = kindForSegment(requestedKindFilter);
      const namespaceFilter = requestedActiveSpace === 'all' ? undefined : requestedActiveSpace;
      const result = await client.service('kb/documents').find({
        query: {
          namespace_slug: namespaceFilter,
          kind,
          archived: false,
          include_indexing: true,
        },
      });
      if (!isCurrent()) return;
      setDocuments(normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[]));
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Failed to load Knowledge:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [client, activeSpace, kindFilter, loadNamespaces, loadMentionDocs]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    if (!namespaces.length) return;
    const nextSpace = resolveKnowledgeSpaceAfterRouteOrNamespacesLoad({
      activeSpace,
      routeNamespaceSlug,
      namespaces,
    });
    if (nextSpace !== activeSpace) updateActiveSpace(nextSpace);
  }, [activeSpace, namespaces, routeNamespaceSlug, updateActiveSpace]);

  useEffect(() => {
    const query = globalSearchQuery.trim();
    if (!client || query.length < 2) {
      setGlobalSearchLoading(false);
      setGlobalSearchError(null);
      setGlobalSearchResults([]);
      setGlobalSearchResultsKey(null);
      return;
    }

    const resultKey = buildKnowledgeSearchResultKey(query, globalSearchMode);
    setGlobalSearchLoading(true);
    setGlobalSearchError(null);
    setGlobalSearchResultsKey(null);

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await client.service('kb/search').find({
          query: {
            q: query,
            mode: globalSearchMode,
            limit: 8,
            include_chunks: true,
          },
        });
        if (cancelled) return;
        setGlobalSearchResults(
          normalizeFindResult<KnowledgeSearchResult>(result as KnowledgeSearchResult[])
        );
        setGlobalSearchResultsKey(resultKey);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to search Knowledge:', err);
        setGlobalSearchResults([]);
        setGlobalSearchResultsKey(resultKey);
        setGlobalSearchError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setGlobalSearchLoading(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, globalSearchMode, globalSearchQuery]);
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

  const loadNamespaceGroups = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.service('groups').findAll({ query: { archived: false } });
      setNamespaceGroups(normalizeFindResult<Group>(result as Group[]));
    } catch (err) {
      console.error('Failed to load Knowledge namespace groups:', err);
      setNamespaceGroups([]);
    }
  }, [client]);

  const loadNamespaceUsers = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.service('users').findAll({});
      setNamespaceUsers(normalizeFindResult<User>(result as User[]));
    } catch (err) {
      console.error('Failed to load Knowledge namespace users:', err);
      setNamespaceUsers([]);
    }
  }, [client]);

  const openKnowledgeSettings = useCallback(() => {
    setKnowledgeSettingsOpen(true);
    setSettingsApiKeyDraft('');
    setSettingsError(null);
    setNamespaceError(null);
    void refreshKnowledgeSettings();
    void loadNamespaces();
    void loadNamespaceGroups();
    void loadNamespaceUsers();
  }, [loadNamespaceGroups, loadNamespaceUsers, loadNamespaces, refreshKnowledgeSettings]);

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

  const openNamespaceEditor = useCallback(
    (namespace?: KnowledgeNamespace | null) => {
      namespaceSlugEditedRef.current = Boolean(namespace);
      setNamespaceEditing(namespace ?? null);
      setNamespaceError(null);
      setNamespaceAclSubject(null);
      setNamespaceAclPermission('read');
      setNamespaceAclDraft(
        !namespace && currentUser?.user_id
          ? [
              {
                subject_type: 'user',
                subject_id: currentUser.user_id,
                permission: 'own',
              },
            ]
          : []
      );
      namespaceForm.setFieldsValue(
        namespace
          ? {
              slug: namespace.slug,
              display_name: namespace.display_name,
              description: namespace.description ?? '',
              kind: namespace.kind,
              visibility_default: namespace.visibility_default,
              others_can: namespace.others_can,
            }
          : {
              slug: '',
              display_name: '',
              description: '',
              kind: 'team',
              visibility_default: 'public',
              others_can: 'none',
            }
      );
      setNamespaceEditorOpen(true);
      if (namespace && client) {
        setNamespaceAclLoading(true);
        const service = getKnowledgeNamespacesService(client);
        service
          .listAcl({ namespace_id: namespace.namespace_id })
          .then((entries) => {
            setNamespaceAclDraft(
              entries.map((entry) => ({
                subject_type: entry.subject_type,
                subject_id: entry.subject_id,
                permission: entry.permission,
              }))
            );
          })
          .catch((err) => {
            console.error('Failed to load Knowledge namespace ACL:', err);
            setNamespaceError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => setNamespaceAclLoading(false));
      }
    },
    [client, currentUser?.user_id, namespaceForm]
  );

  const handleNamespaceValuesChange = useCallback(
    (changedValues: Partial<KnowledgeNamespaceFormValues>) => {
      if (Object.hasOwn(changedValues, 'slug')) {
        namespaceSlugEditedRef.current = true;
        return;
      }

      if (
        !namespaceEditing &&
        Object.hasOwn(changedValues, 'display_name') &&
        !namespaceSlugEditedRef.current
      ) {
        namespaceForm.setFieldsValue({ slug: slugify(changedValues.display_name || '') });
      }
    },
    [namespaceEditing, namespaceForm]
  );

  const addNamespaceAclDraftEntry = useCallback(() => {
    const parsed = parseNamespaceSubjectValue(namespaceAclSubject);
    if (!parsed) return;
    setNamespaceAclDraft((prev) => {
      const nextEntry: KnowledgeNamespaceAclDraftEntry = {
        subject_type: parsed.subjectType,
        subject_id: parsed.subjectId,
        permission: namespaceAclPermission,
      };
      const existingIndex = prev.findIndex(
        (entry) =>
          entry.subject_type === parsed.subjectType && entry.subject_id === parsed.subjectId
      );
      if (existingIndex === -1) return [...prev, nextEntry];
      return prev.map((entry, index) => (index === existingIndex ? nextEntry : entry));
    });
    setNamespaceAclSubject(null);
    setNamespaceAclPermission('read');
  }, [namespaceAclPermission, namespaceAclSubject]);

  const updateNamespaceAclDraftPermission = useCallback(
    (entry: KnowledgeNamespaceAclDraftEntry, permission: KnowledgeNamespacePermission) => {
      setNamespaceAclDraft((prev) =>
        prev.map((item) =>
          item.subject_type === entry.subject_type && item.subject_id === entry.subject_id
            ? { ...item, permission }
            : item
        )
      );
    },
    []
  );

  const removeNamespaceAclDraftEntry = useCallback((entry: KnowledgeNamespaceAclDraftEntry) => {
    setNamespaceAclDraft((prev) =>
      prev.filter(
        (item) => item.subject_type !== entry.subject_type || item.subject_id !== entry.subject_id
      )
    );
  }, []);

  const saveNamespace = useCallback(async () => {
    if (!client) return;
    setNamespaceSaving(true);
    setNamespaceError(null);
    try {
      const values = await namespaceForm.validateFields();
      const payload = {
        ...values,
        slug: values.slug.trim(),
        display_name: values.display_name.trim(),
        description: values.description?.trim() || null,
      };
      const service = getKnowledgeNamespacesService(client);
      const result = await service.saveWithAcl({
        namespace_id: namespaceEditing?.namespace_id,
        namespace: namespaceEditing
          ? {
              ...payload,
              slug: namespaceEditing.slug,
            }
          : payload,
        acl: namespaceAclDraft,
      });
      setNamespaceAclDraft(
        result.acl.map((entry) => ({
          subject_type: entry.subject_type,
          subject_id: entry.subject_id,
          permission: entry.permission,
        }))
      );
      if (namespaceEditing) {
        setNamespaces((prev) =>
          prev.map((namespace) =>
            namespace.namespace_id === result.namespace.namespace_id ? result.namespace : namespace
          )
        );
      } else {
        setNamespaces((prev) => [result.namespace, ...prev]);
      }
      await loadNamespaces();
      setNamespaceEditorOpen(false);
      setNamespaceEditing(null);
    } catch (err) {
      console.error('Failed to save Knowledge namespace:', err);
      setNamespaceError(err instanceof Error ? err.message : String(err));
    } finally {
      setNamespaceSaving(false);
    }
  }, [client, loadNamespaces, namespaceAclDraft, namespaceEditing, namespaceForm]);

  const archiveNamespace = useCallback(
    (namespace: KnowledgeNamespace) => {
      if (!client) return;
      confirm({
        title: `Archive ${namespace.display_name || namespace.slug}?`,
        content:
          'Archiving a namespace also archives its documents. This can disrupt Knowledge links and search.',
        okText: 'Archive namespace',
        okButtonProps: { danger: true },
        onOk: async () => {
          setNamespaceError(null);
          try {
            await client.service('kb/namespaces').remove(namespace.namespace_id);
            await loadNamespaces();
            if (activeSpace === namespace.slug) updateActiveSpace('all');
          } catch (err) {
            console.error('Failed to archive Knowledge namespace:', err);
            setNamespaceError(err instanceof Error ? err.message : String(err));
          }
        },
      });
    },
    [activeSpace, client, confirm, loadNamespaces, updateActiveSpace]
  );

  // The namespace graph is scoped to a single Space; "All Spaces" has no graph.
  const loadGraph = useCallback(async () => {
    const requestId = graphRequestSeqRef.current + 1;
    graphRequestSeqRef.current = requestId;
    const requestedActiveSpace = activeSpace;
    const isCurrent = () =>
      requestId === graphRequestSeqRef.current && requestedActiveSpace === activeSpaceRef.current;

    if (!client || requestedActiveSpace === 'all') {
      setGraphData(null);
      setGraphLoading(false);
      return;
    }
    setGraphLoading(true);
    try {
      const result = await client.service('kb/graph').find({
        query: { namespace: requestedActiveSpace },
      });
      if (!isCurrent()) return;
      setGraphData(result as unknown as KnowledgeNamespaceGraph);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Failed to load Knowledge graph:', err);
      setGraphData(null);
    } finally {
      if (isCurrent()) setGraphLoading(false);
    }
  }, [client, activeSpace]);

  // Refresh the graph whenever it becomes the visible view (no doc open), so
  // edges created by a just-saved edit show up on return.
  useEffect(() => {
    if (!activeDocId && !routeDocumentPath) loadGraph();
  }, [activeDocId, loadGraph, routeDocumentPath]);

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
      setActiveDocSnapshot(null);
    }
    if (routeNamespaceSlug && nextSpace !== activeSpace) updateActiveSpace(nextSpace);
    setGlobalSearchQuery((current) => (current === nextQuery ? current : nextQuery));
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
    routeDocumentPath,
    routeNamespaceSlug,
    routeSearchParams,
    draftDocument,
    updateActiveSpace,
  ]);

  useEffect(() => {
    if (activeDocIdRef.current === DRAFT_DOCUMENT_ID) return;
    if (!client || !routeNamespaceSlug || !routeDocumentPath) return;
    const currentRouteKey = routeDocumentKey;
    if (!currentRouteKey) return;

    const snapshotMatchesRoute =
      activeDocSnapshot?.path === routeDocumentPath &&
      namespaceSlugForDocument(activeDocSnapshot) === routeNamespaceSlug;
    if (snapshotMatchesRoute) {
      setRouteDocumentResolutionFailure((current) =>
        current?.key === currentRouteKey ? null : current
      );
      if (activeDocSnapshot.document_id !== activeDocId) {
        activeDocIdRef.current = activeDocSnapshot.document_id;
        setActiveDocId(activeDocSnapshot.document_id);
      }
      return;
    }

    const routedDocument = documents.find(
      (doc) =>
        doc.path === routeDocumentPath && namespaceSlugForDocument(doc) === routeNamespaceSlug
    );
    if (routedDocument) {
      setRouteDocumentResolutionFailure((current) =>
        current?.key === currentRouteKey ? null : current
      );
      setActiveDocSnapshot(routedDocument);
      if (routedDocument.document_id !== activeDocId) {
        activeDocIdRef.current = routedDocument.document_id;
        setActiveDocId(routedDocument.document_id);
      }
      return;
    }

    // The sidebar list is filtered by kind/search. A direct document URL must
    // still resolve even when that document is not present in the filtered tree.
    let cancelled = false;
    void client
      .service('kb/documents')
      .find({
        query: {
          namespace_slug: routeNamespaceSlug,
          path: routeDocumentPath,
          archived: false,
        },
      })
      .then((result) => {
        if (cancelled || activeDocIdRef.current === DRAFT_DOCUMENT_ID) return;
        const [resolvedDocument] = normalizeFindResult<KnowledgeDocument>(
          result as KnowledgeDocument[]
        );
        if (!resolvedDocument) {
          activeDocIdRef.current = null;
          setActiveDocId(null);
          setActiveDocSnapshot(null);
          setRouteDocumentResolutionFailure({
            key: currentRouteKey,
            message: 'Knowledge page not found.',
          });
          return;
        }
        setRouteDocumentResolutionFailure((current) =>
          current?.key === currentRouteKey ? null : current
        );
        setActiveDocSnapshot(resolvedDocument);
        activeDocIdRef.current = resolvedDocument.document_id;
        setActiveDocId(resolvedDocument.document_id);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to resolve Knowledge route document:', err);
          activeDocIdRef.current = null;
          setActiveDocId(null);
          setActiveDocSnapshot(null);
          setRouteDocumentResolutionFailure({
            key: currentRouteKey,
            message: err instanceof Error ? err.message : 'Failed to load Knowledge page.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeDocId,
    activeDocSnapshot,
    client,
    documents,
    namespaceSlugForDocument,
    routeDocumentKey,
    routeDocumentPath,
    routeNamespaceSlug,
  ]);

  useEffect(() => {
    if (!client || loading || activeDocIdRef.current === DRAFT_DOCUMENT_ID) return;
    if (!routeNamespaceSlug || !routeDocumentPath) return;
    const routedDocument = documents.find(
      (doc) =>
        doc.path === routeDocumentPath && namespaceSlugForDocument(doc) === routeNamespaceSlug
    );
    if (routedDocument) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.service('kb/documents').find({
          query: {
            namespace_slug: routeNamespaceSlug,
            path: routeDocumentPath,
            archived: false,
            include_other_user_drafts: true,
            include_indexing: true,
          },
        });
        if (cancelled) return;
        const [directDoc] = normalizeFindResult<KnowledgeDocument>(result as KnowledgeDocument[]);
        if (!directDoc) return;
        setRouteDocumentResolutionFailure((current) =>
          current?.key === routeDocumentKey ? null : current
        );
        setDocuments((prev) =>
          prev.some((doc) => doc.document_id === directDoc.document_id)
            ? prev
            : [directDoc, ...prev]
        );
        setActiveDocSnapshot(directDoc);
        activeDocIdRef.current = directDoc.document_id;
        setActiveDocId(directDoc.document_id);
      } catch (err) {
        if (!cancelled) console.error('Failed to load direct Knowledge document:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    client,
    documents,
    loading,
    namespaceSlugForDocument,
    routeDocumentKey,
    routeDocumentPath,
    routeNamespaceSlug,
  ]);

  useEffect(() => {
    if (activeDocIdRef.current === DRAFT_DOCUMENT_ID) return;
    if (activeDocId && !activeDoc && !loading && !routeDocumentPath) {
      activeDocIdRef.current = null;
      setActiveDocId(null);
      setActiveDocSnapshot(null);
    }
  }, [activeDoc, activeDocId, loading, routeDocumentPath]);

  useEffect(() => {
    if (activeDoc) {
      setSelectedFolder(parentFolderForPath(activeDoc.path));
      setTitleDraft(activeDoc.title);
      setVisibilityDraft(activeDoc.visibility);
      setStatusDraft(activeDoc.status ?? 'published');
      setKindDraft(activeDoc.kind);
      setIconEmojiDraft(activeDoc.icon_emoji ?? null);
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
      shouldDeferKnowledgeUrlMirrorForRoute({
        routeDocumentPath,
        activeDocPath: activeDoc?.path,
      })
    ) {
      return;
    }
    if (
      activeDoc &&
      routeNamespaceSlug &&
      routeNamespaceSlug !== namespaceSlugForDocument(activeDoc)
    ) {
      return;
    }

    // Only an OPEN document's *path* drives the URL from this effect. Query
    // params (`q`, `mode`, `draft`) are owned by explicit UI navigation
    // handlers and read back into state by the route-reading effect above.
    // Rebuilding query params here from local state creates a two-writer value:
    // after a route change, local state can lag by one render, so this effect
    // removes the new query param; the route reader then applies the old/new
    // state in the opposite direction and the URL ping-pongs forever.
    //
    // This is the same ownership rule as namespace/path routing: path mirroring
    // may correct the document route, but it must preserve the URL's current
    // query string verbatim.
    if (!activeDoc) return;

    const targetUrl = buildKnowledgeDocumentRouteUrl({
      routeBasePath,
      namespaceSlug: namespaceSlugForDocument(activeDoc),
      documentPath: activeDoc.path,
      currentSearch: location.search,
    });
    const targetUrlWithHash = `${targetUrl}${location.hash}`;
    const currentUrl = `${location.pathname}${location.search}${location.hash}`;
    if (targetUrlWithHash !== currentUrl) navigate(targetUrlWithHash, { replace: true });
  }, [
    activeDoc,
    activeDocId,
    documents,
    draftDocument,
    location.hash,
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
      setVersionsDocumentId(DRAFT_DOCUMENT_ID);
      return;
    }
    if (!client || !activeDoc) {
      setVersions([]);
      setVersionsDocumentId(null);
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
      setVersionsDocumentId(documentId);
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
      setVersionsDocumentId(documentId);
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
      status: 'published',
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
    setActiveDocSnapshot(null);
    activeDocIdRef.current = DRAFT_DOCUMENT_ID;
    setActiveDocId(DRAFT_DOCUMENT_ID);
    setSelectedFolder(ROOT_FOLDER);
    setTitleDraft(title);
    setVisibilityDraft(draft.visibility);
    setStatusDraft(draft.status);
    setKindDraft(draft.kind);
    setIconEmojiDraft(draft.icon_emoji ?? null);
    setTitleFromContent(true);
    setRenamePathOnTitleChange(false);
    setMarkdownDraft(`# ${title}\n\nWrite markdown here.\n`);
    setVersions([]);
    setVersionsDocumentId(DRAFT_DOCUMENT_ID);
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
        status: 'published',
        metadata: { title_from_content: true },
        content_text: `# ${title}\n\nWrite markdown here.\n`,
        change_summary: 'Initial version',
      } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
      setDocuments((prev) => [created, ...prev]);
      updateActiveSpace(namespaceSlug);
      setActiveDocSnapshot(created);
      activeDocIdRef.current = created.document_id;
      setActiveDocId(created.document_id);
      setSelectedFolder(parentFolderForPath(created.path));
      setMarkdownDraft(`# ${title}\n\nWrite markdown here.\n`);
      setVersionsDocumentId(created.document_id);
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
          icon_emoji: iconEmojiDraft,
          visibility: visibilityDraft,
          status: statusDraft,
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
        updateActiveSpace(namespaceSlug);
        setActiveDocSnapshot(created);
        activeDocIdRef.current = created.document_id;
        setActiveDocId(created.document_id);
        setSelectedFolder(parentFolderForPath(created.path));
        setVersions([]);
        setVersionsDocumentId(created.document_id);
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
        status: statusDraft,
        kind: kindDraft,
        icon_emoji: iconEmojiDraft,
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
      setActiveDocSnapshot(updated);
      await loadVersions();
      if (nextPath) {
        pendingEditModeRef.current = false;
        setIsEditing(false);
        navigate(
          `${buildKnowledgeRoutePath(
            routeBasePath,
            namespaceSlugForDocument(updated),
            updated.path
          )}${buildKnowledgeSearch({ editing: false })}`,
          { replace: true }
        );
      } else {
        setKnowledgeEditMode(false);
      }
    } catch (err) {
      console.error('Failed to save Knowledge document:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const moveDocumentToFolder = async (doc: KnowledgeDocument, folder: string) => {
    if (!client) return;

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
      setActiveDocSnapshot(updated);
      activeDocIdRef.current = updated.document_id;
      setActiveDocId(updated.document_id);
      setSelectedFolder(targetFolder);
      setExpandedTreeKeys((prev) => [...new Set([...prev, `folder:${targetFolder}`])]);
      navigate(
        `${buildKnowledgeRoutePath(
          routeBasePath,
          namespaceSlugForDocument(updated),
          updated.path
        )}${buildKnowledgeSearch({ editing: false })}`,
        { replace: true }
      );
    } catch (err) {
      console.error('Failed to move Knowledge document:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const updateActiveDocumentIcon = async (emoji: string | null) => {
    if (!activeDoc) return;
    const nextIcon = normalizeKnowledgeDocumentIconEmoji(emoji);
    setIconEmojiDraft(nextIcon);
    if (isDraftDocument) {
      setDraftDocument((current) => (current ? { ...current, icon_emoji: nextIcon } : current));
      return;
    }
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const updated = (await client.service('kb/documents').patch(activeDoc.document_id, {
        icon_emoji: nextIcon,
        change_summary: nextIcon
          ? 'Updated Knowledge document icon'
          : 'Removed Knowledge document icon',
      } as unknown as Partial<CoreKnowledgeDocument>)) as KnowledgeDocument;
      setDocuments((prev) =>
        prev.map((doc) => (doc.document_id === updated.document_id ? updated : doc))
      );
      setActiveDocSnapshot(updated);
    } catch (err) {
      console.error('Failed to update Knowledge document icon:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderKnowledgeIconPicker = (onChange: (emoji: string | null) => void) => {
    const selectIcon = (emoji: string | null) => {
      onChange(emoji);
      setIconPickerOpen(false);
    };
    return (
      <Space direction="vertical" size={8} onClick={(event) => event.stopPropagation()}>
        <AgorEmojiPicker onEmojiClick={(emojiData) => selectIcon(emojiData.emoji)} />
        <Button block onClick={() => selectIcon(null)}>
          Remove icon
        </Button>
      </Space>
    );
  };

  const cancelEdit = () => {
    if (!activeDoc) return;
    if (isDraftDocument) {
      setDraftDocument(null);
      setDraftNamespaceSlug(null);
      activeDocIdRef.current = null;
      setActiveDocId(null);
      setActiveDocSnapshot(null);
      setTitleDraft('');
      setVisibilityDraft('public');
      setKindDraft('doc');
      setIconEmojiDraft(null);
      setTitleFromContent(false);
      setRenamePathOnTitleChange(false);
      setMarkdownDraft(DEFAULT_MARKDOWN);
      setVersions([]);
      setVersionsDocumentId(null);
      setKnowledgeEditMode(false);
      return;
    }
    setTitleDraft(activeDoc.title);
    setVisibilityDraft(activeDoc.visibility);
    setKindDraft(activeDoc.kind);
    setIconEmojiDraft(activeDoc.icon_emoji ?? null);
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
      setActiveDocSnapshot(updated);
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
          setActiveDocSnapshot(null);
          setVersions([]);
          setVersionsDocumentId(null);
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
    setActiveDocSnapshot(doc);
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

  const selectKnowledgeSearchResult = async (result: KnowledgeSearchResult) => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    const doc = result.document;
    clearDraftDocument();
    updateActiveSpace(result.namespace.slug);
    setActiveDocSnapshot(doc);
    activeDocIdRef.current = doc.document_id;
    setActiveDocId(doc.document_id);
    pendingEditModeRef.current = false;
    setIsEditing(false);
    setGlobalSearchOpen(false);
    navigate(buildKnowledgeRoutePath(routeBasePath, result.namespace.slug, doc.path));
  };

  const goToGraphHome = async () => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    clearDraftDocument();
    activeDocIdRef.current = null;
    setActiveDocId(null);
    setActiveDocSnapshot(null);
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
    activeDocIdRef.current = null;
    setActiveDocId(null);
    setActiveDocSnapshot(null);
    const slug = namespaceSlugFromUri(node.uri) ?? activeSpace;
    updateKindFilter('All');
    setSidebarFilterQuery('');
    pendingEditModeRef.current = false;
    setIsEditing(false);
    navigate(buildKnowledgeRoutePath(routeBasePath, slug, node.path));
  };

  const changeKnowledgeSpace = async (space: string) => {
    if (!(await confirmDiscardUnsavedChanges())) return;
    clearDraftDocument();
    updateActiveSpace(space);
    activeDocIdRef.current = null;
    setActiveDocId(null);
    setActiveDocSnapshot(null);
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
        {doc.icon_emoji ? (
          <span style={{ fontSize: 15, lineHeight: 1, width: 14, textAlign: 'center' }}>
            {doc.icon_emoji}
          </span>
        ) : (
          <FileOutlined style={{ color: token.colorTextTertiary, fontSize: 13 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: isActive ? 600 : 400,
            }}
          >
            <HighlightMatch text={doc.title} query={sidebarFilterQuery} />
          </span>
          {sidebarFilterActive && (
            <span
              style={{
                display: 'block',
                color: token.colorTextTertiary,
                fontSize: 11,
                lineHeight: 1.2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <HighlightMatch text={doc.path} query={sidebarFilterQuery} />
            </span>
          )}
        </div>
        {doc.status === 'draft' && (
          <Tag
            color="gold"
            bordered={false}
            style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}
          >
            Draft
          </Tag>
        )}
      </button>
    );
  };

  const sidebarFilterActive = Boolean(sidebarFilterQuery.trim());
  const documentMatchesSidebarFilter = (doc: KnowledgeDocument) =>
    matchesKnowledgeSidebarFilter([doc.title, doc.path], sidebarFilterQuery);
  const folderMatchesSidebarFilter = (folder: FolderSection) =>
    matchesKnowledgeSidebarFilter([folder.name], sidebarFilterQuery);

  const filteredDocsForFolder = (folder: FolderSection): KnowledgeDocument[] =>
    sidebarFilterActive ? folder.docs.filter(documentMatchesSidebarFilter) : folder.docs;

  const shouldShowFolderInSidebar = (folder: FolderSection): boolean => {
    if (folder.path === ROOT_FOLDER) return true;
    const matchingDocs = filteredDocsForFolder(folder);
    const hasDocuments = matchingDocs.length > 0;
    const hasVisibleChildren = folder.children.some(shouldShowFolderInSidebar);
    const isLocalEmptyFolder = localFolders.includes(folder.path);
    return (
      hasDocuments ||
      hasVisibleChildren ||
      (sidebarFilterActive ? folderMatchesSidebarFilter(folder) : isLocalEmptyFolder)
    );
  };

  const renderFolderSection = (folder: FolderSection, depth = 0): React.ReactNode => {
    if (!shouldShowFolderInSidebar(folder)) return null;
    const visibleChildren = folder.children.filter(shouldShowFolderInSidebar);
    const visibleDocs = filteredDocsForFolder(folder);
    const childCount = visibleDocs.length + visibleChildren.length;
    const hasChildren = childCount > 0;
    const collapsed = !sidebarFilterActive && hasChildren && collapsedFolders.has(folder.path);
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
            <HighlightMatch text={folder.name} query={sidebarFilterQuery} />
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
            {visibleDocs.map((doc) => renderDocumentRow(doc, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderRootContents = (): React.ReactNode => {
    const visibleRootChildren = folderHierarchy.children.filter(shouldShowFolderInSidebar);
    const visibleRootDocs = filteredDocsForFolder(folderHierarchy);

    if (sidebarFilterActive && visibleRootChildren.length === 0 && visibleRootDocs.length === 0) {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No visible docs match this filter"
          style={{ margin: '12px 0' }}
        />
      );
    }

    return (
      <>
        {visibleRootChildren.map((child) => renderFolderSection(child, 0))}
        {visibleRootDocs.map((doc) => renderDocumentRow(doc, 0))}
      </>
    );
  };

  const trimmedGlobalSearchQuery = globalSearchQuery.trim();
  const globalSearchResultsFresh = areKnowledgeSearchResultsFresh({
    resultKey: globalSearchResultsKey,
    query: trimmedGlobalSearchQuery,
    mode: globalSearchMode,
  });
  const visibleGlobalSearchResults = globalSearchResultsFresh ? globalSearchResults : [];

  const globalSearchContent = (
    <div style={{ width: 520, maxWidth: 'min(520px, calc(100vw - 48px))' }}>
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        <Flex justify="space-between" align="center" gap={8}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Searches readable Knowledge titles, paths, and content.
          </Text>
          <Segmented
            size="small"
            value={globalSearchMode}
            onChange={(value) => setGlobalSearchMode(value as KnowledgeSearchMode)}
            options={[
              { label: 'Text', value: 'text' },
              { label: 'Semantic', value: 'semantic' },
              { label: 'Hybrid', value: 'hybrid' },
            ]}
          />
        </Flex>
        {globalSearchError && (
          <Alert type="warning" showIcon message={globalSearchError} style={{ padding: 8 }} />
        )}
        <Spin spinning={globalSearchLoading}>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {trimmedGlobalSearchQuery.length < 2 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Type at least 2 characters to search all Knowledge."
              />
            ) : visibleGlobalSearchResults.length === 0 && !globalSearchLoading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No Knowledge results" />
            ) : (
              <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                {visibleGlobalSearchResults.map((result) => {
                  const doc = result.document;
                  const snippet = compactKnowledgeSnippet(
                    result.chunks?.find((chunk) => chunk.snippet)?.snippet ?? result.snippet
                  );
                  return (
                    <button
                      key={doc.document_id}
                      type="button"
                      onClick={() => selectKnowledgeSearchResult(result)}
                      style={{
                        width: '100%',
                        border: 0,
                        borderRadius: token.borderRadius,
                        background: 'transparent',
                        color: token.colorText,
                        cursor: 'pointer',
                        padding: '8px 10px',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = token.colorFillQuaternary;
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <Flex align="baseline" gap={8} style={{ minWidth: 0 }}>
                        {doc.icon_emoji && (
                          <span style={{ fontSize: 15, lineHeight: 1 }}>{doc.icon_emoji}</span>
                        )}
                        <Text strong style={{ flex: 1, minWidth: 0 }} ellipsis>
                          <HighlightMatch text={doc.title} query={globalSearchQuery} />
                        </Text>
                        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                          {kindLabels[doc.kind] ?? doc.kind}
                        </Tag>
                      </Flex>
                      <Text type="secondary" style={{ display: 'block', fontSize: 12 }} ellipsis>
                        <HighlightMatch
                          text={`${result.namespace.display_name || result.namespace.slug} / ${doc.path}`}
                          query={globalSearchQuery}
                        />
                      </Text>
                      {snippet && (
                        <Text
                          type="secondary"
                          style={{
                            display: '-webkit-box',
                            fontSize: 12,
                            lineHeight: 1.35,
                            marginTop: 2,
                            overflow: 'hidden',
                            WebkitBoxOrient: 'vertical',
                            WebkitLineClamp: 2,
                          }}
                        >
                          <HighlightMatch text={snippet} query={globalSearchQuery} />
                        </Text>
                      )}
                    </button>
                  );
                })}
              </Space>
            )}
          </div>
        </Spin>
      </Space>
    </div>
  );

  const namespaceOptions = buildKnowledgeNamespaceSelectOptions(namespaces);
  const spaceOptions = [{ label: 'All Spaces', value: 'all' }, ...namespaceOptions];
  const createFolderError = validateKnowledgePath(createFolder, { allowEmpty: true });
  const newFolderParentError = validateKnowledgePath(newFolderParent, { allowEmpty: true });
  const newFolderNameError = normalizeFolderPath(newFolderName)
    ? validateKnowledgePath(newFolderName)
    : null;
  const folderNameHelp =
    'Use letters, numbers, spaces, dashes, underscores, dots, and / for subfolders.';
  const showReadActions = titleActionsVisible || iconPickerOpen;
  const activeDocMatchesRoute =
    !routeDocumentPath ||
    Boolean(
      activeDoc &&
        activeDoc.path === routeDocumentPath &&
        (!routeNamespaceSlug || namespaceSlugForDocument(activeDoc) === routeNamespaceSlug)
    );
  const showRouteDocumentFailure = Boolean(
    routeDocumentKey &&
      routeDocumentResolutionFailure &&
      routeDocumentResolutionFailure.key === routeDocumentKey
  );
  // Graph is the home view: shown in the main panel whenever no doc is open.
  const showRouteDocumentLoading = shouldShowKnowledgeRouteDocumentLoading({
    activeDocMatchesRoute,
    routeDocumentResolutionFailed: showRouteDocumentFailure,
    routeNamespaceSlug,
    routeDocumentPath,
  });
  const showGraph = shouldShowKnowledgeGraphView({
    activeDocPresent: Boolean(activeDoc),
    isEditing,
    routeDocumentPath,
  });
  const showDocumentLoading =
    showRouteDocumentLoading ||
    Boolean(activeDoc && (!activeDocMatchesRoute || !activeDocContentReady));
  const fillMain = isEditing || showGraph || showDocumentLoading || showRouteDocumentFailure;

  useEffect(() => {
    if (!location.hash || isEditing || showDocumentLoading || !activeDocMatchesRoute) return;

    const hash = location.hash.slice(1);
    const targetId = safeDecodeURIComponent(hash);
    let cancelled = false;
    const scrollToHeading = () => {
      if (cancelled) return;
      const target =
        document.getElementById(targetId) ||
        (targetId !== hash ? document.getElementById(hash) : null);
      target?.scrollIntoView({ block: 'start' });
    };

    const frame = window.requestAnimationFrame(scrollToHeading);
    const timeout = window.setTimeout(scrollToHeading, 80);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [activeDocMatchesRoute, isEditing, location.hash, showDocumentLoading]);

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
          <BrandLogo level={3} style={{ marginTop: -4 }} />
          <Text
            strong
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: token.sizeUnit,
              fontSize: 15,
              cursor: 'pointer',
            }}
            onClick={goToGraphHome}
          >
            <BulbOutlined style={{ color: token.colorTextSecondary }} />
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
        <div
          ref={globalSearchContainerRef}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setGlobalSearchOpen(false);
          }}
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            minWidth: 220,
            padding: '0 20px',
          }}
        >
          <Popover
            open={globalSearchOpen}
            onOpenChange={(open) => {
              // Input focus opens the popover before AntD's click trigger fires;
              // ignore close toggles from clicking the input/search button so the
              // dropdown does not flash shut and require a second click. Outside
              // clicks are handled by the pointerdown listener above.
              if (open) setGlobalSearchOpen(true);
            }}
            trigger="click"
            placement="bottom"
            content={globalSearchContent}
            arrow={false}
            getPopupContainer={(triggerNode) =>
              globalSearchContainerRef.current ?? triggerNode.parentElement ?? document.body
            }
          >
            <Input.Search
              allowClear
              aria-label="Search all Knowledge"
              placeholder="Search all Knowledge…"
              prefix={<SearchOutlined />}
              value={globalSearchQuery}
              onClick={() => setGlobalSearchOpen(true)}
              onFocus={() => setGlobalSearchOpen(true)}
              onChange={(event) => {
                setGlobalSearchQuery(event.target.value);
                setGlobalSearchOpen(true);
              }}
              onSearch={(value, _event, info) => {
                if (info?.source === 'clear' || globalSearchLoading) return;
                const submittedQuery = value.trim();
                const submittedResultsFresh = areKnowledgeSearchResultsFresh({
                  resultKey: globalSearchResultsKey,
                  query: submittedQuery,
                  mode: globalSearchMode,
                });
                if (!submittedResultsFresh) return;
                const first = globalSearchResults[0];
                if (first) void selectKnowledgeSearchResult(first);
              }}
              loading={globalSearchLoading}
              style={{ width: 'min(520px, 100%)' }}
            />
          </Popover>
        </div>
        <Space>
          <Tooltip title="Refresh Knowledge" placement="bottom">
            <Button
              type="text"
              aria-label="Refresh Knowledge"
              icon={<ReloadOutlined style={{ fontSize: token.fontSizeLG }} />}
              onClick={loadDocuments}
              loading={loading}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            />
          </Tooltip>
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

      <Content style={{ height: 'calc(100vh - 56px)', overflow: 'hidden', padding: 0 }}>
        <PanelGroup
          id="knowledge-layout"
          direction="horizontal"
          style={{ height: '100%' }}
          onLayout={(sizes) => {
            if (sidebarResizeDraggingRef.current && sizes.length >= 2) {
              setSidebarSize(clampPercent(sizes[0], sidebarMinSize, sidebarMaxSize));
            }
          }}
        >
          <Panel
            id="knowledge-sidebar"
            order={1}
            ref={sidebarPanelRef}
            defaultSize={effectiveSidebarSize}
            minSize={sidebarMinSize}
            maxSize={sidebarMaxSize}
            style={{ minWidth: KNOWLEDGE_SIDEBAR_MIN_WIDTH_PX }}
          >
            <aside
              style={{
                height: '100%',
                boxSizing: 'border-box',
                borderRight: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                padding: 16,
                overflow: 'auto',
              }}
            >
              <Space orientation="vertical" size={12} style={{ width: '100%' }}>
                {!client && (
                  <Alert type="warning" title="Knowledge requires a daemon connection." />
                )}
                <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>
                    Space
                  </Text>
                  <Select
                    {...searchableSelectProps}
                    value={activeSpace}
                    onChange={changeKnowledgeSpace}
                    style={{ width: '100%' }}
                    options={spaceOptions}
                  />
                </Space>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="Filter visible docs"
                  aria-label="Filter visible Knowledge docs"
                  value={sidebarFilterQuery}
                  onChange={(event) => setSidebarFilterQuery(event.target.value)}
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
                  onChange={(value) => updateKindFilter(String(value))}
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
                        background: showGraph ? token.colorPrimaryBg : 'transparent',
                        color: token.colorText,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontWeight: showGraph ? 600 : 400,
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
          </Panel>
          <PanelResizeHandle
            style={{
              width: '4px',
              background: token.colorBorderSecondary,
              cursor: 'col-resize',
              transition: 'background 0.2s',
            }}
            onDragging={(isDragging) => {
              sidebarResizeDraggingRef.current = isDragging;
            }}
            onMouseEnter={(event) => {
              (event.currentTarget as unknown as HTMLDivElement).style.background =
                token.colorPrimary;
            }}
            onMouseLeave={(event) => {
              (event.currentTarget as unknown as HTMLDivElement).style.background =
                token.colorBorderSecondary;
            }}
          />
          <Panel id="knowledge-main" order={2} minSize={30}>
            <main
              style={{
                height: '100%',
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

                {activeDoc && activeDocMatchesRoute && activeDocContentReady ? (
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
                        <Flex align="center" gap={12} style={{ width: '100%' }}>
                          <Popover
                            trigger="click"
                            placement="bottomLeft"
                            onOpenChange={setIconPickerOpen}
                            content={renderKnowledgeIconPicker(
                              isEditing ? setIconEmojiDraft : updateActiveDocumentIcon
                            )}
                          >
                            <Button
                              type="text"
                              size="large"
                              disabled={!client && !isDraftDocument}
                              style={{
                                fontSize: 30,
                                width: 52,
                                height: 52,
                                padding: 0,
                                color: activeDocIconEmoji ? undefined : token.colorTextTertiary,
                              }}
                              aria-label={
                                activeDocIconEmoji
                                  ? 'Change Knowledge document emoji icon'
                                  : 'Add Knowledge document emoji icon'
                              }
                            >
                              {activeDocIconEmoji ? (
                                <span style={{ fontSize: 39, lineHeight: 1 }}>
                                  {activeDocIconEmoji}
                                </span>
                              ) : (
                                <FileOutlined />
                              )}
                            </Button>
                          </Popover>
                          <div style={{ flex: 1, minWidth: 0 }}>
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
                          </div>
                        </Flex>
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
                              value={statusDraft}
                              disabled={!canManageActiveVisibility}
                              onChange={setStatusDraft}
                              style={{ width: 118 }}
                              options={[
                                { label: 'Published', value: 'published' },
                                { label: 'Draft', value: 'draft' },
                              ]}
                            />
                          ) : activeDoc.status === 'draft' ? (
                            <Tag color="gold">Draft</Tag>
                          ) : (
                            <Tag color="blue">Published</Tag>
                          )}
                          <IndexingStatusCue status={activeDoc.indexing_status} size={16} />
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
                                boxShadow: titleActionsVisible
                                  ? token.boxShadowSecondary
                                  : undefined,
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
                            <MarkdownRenderer
                              content={hydrateKbLinks(markdownDraft)}
                              headingAnchors
                            />
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
                          headingAnchors
                        />
                      </div>
                    )}
                  </div>
                ) : showDocumentLoading ? (
                  <Flex
                    vertical
                    align="center"
                    justify="center"
                    style={{ flex: 1, minHeight: 320, width: '100%' }}
                  >
                    <Spin />
                  </Flex>
                ) : showRouteDocumentFailure ? (
                  <Flex
                    vertical
                    align="center"
                    justify="center"
                    style={{ flex: 1, minHeight: 320, width: '100%' }}
                  >
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={
                        routeDocumentResolutionFailure?.message ?? 'Knowledge page not found.'
                      }
                    />
                  </Flex>
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
          </Panel>
        </PanelGroup>
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
              renderItem={(version, index) => {
                const reuse = embeddingReuseIntoNext(version);
                const targetVersion = reuse?.targetVersionId
                  ? versions.find((item) => item.version_id === reuse.targetVersionId)
                  : null;
                return (
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
                        <Space wrap>
                          <Text strong>v{version.version_number}</Text>
                          {index === 0 && <Tag color="green">Current</Tag>}
                          {reuse && (
                            <Popover
                              content={
                                <Space orientation="vertical" size={4}>
                                  <Text>
                                    When{' '}
                                    {targetVersion
                                      ? `v${targetVersion.version_number}`
                                      : 'the next version'}{' '}
                                    was indexed, Agor reused {reuse.reusedChunks} of{' '}
                                    {reuse.totalChunks} chunk embeddings from matching normalized
                                    chunk hashes.
                                  </Text>
                                  {(reuse.model || reuse.dimensions) && (
                                    <Text type="secondary">
                                      {[reuse.model, reuse.dimensions && `${reuse.dimensions}d`]
                                        .filter(Boolean)
                                        .join(' · ')}
                                    </Text>
                                  )}
                                  {reuse.updatedAt && (
                                    <Text type="secondary">
                                      Recorded {formatTimestamp(reuse.updatedAt)}
                                    </Text>
                                  )}
                                </Space>
                              }
                            >
                              <Tag color="green">
                                ♻️ {`${reuse.reusedChunks}/${reuse.totalChunks}`}
                              </Tag>
                            </Popover>
                          )}
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
                );
              }}
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
                      headingAnchors
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
        title="Knowledge settings"
        open={knowledgeSettingsOpen}
        onCancel={() => setKnowledgeSettingsOpen(false)}
        footer={null}
        width={760}
      >
        <Spin spinning={settingsLoading}>
          <Tabs
            defaultActiveKey="namespaces"
            items={[
              {
                key: 'namespaces',
                label: 'Namespaces',
                children: (
                  <Space direction="vertical" size={16} style={{ width: '100%' }}>
                    <Alert
                      type="info"
                      showIcon
                      message="Namespaces are the Knowledge RBAC boundary. Use the workspace fallback for broad access, and add specific user or group grants below when access should be narrower."
                    />
                    {namespaceError && <Alert type="error" showIcon message={namespaceError} />}
                    <Flex justify="space-between" align="center">
                      <Space direction="vertical" size={0}>
                        <Text strong>Knowledge namespaces</Text>
                        <Text type="secondary">
                          Create and manage Knowledge spaces, defaults, and broad workspace access.
                        </Text>
                      </Space>
                      <Button type="primary" onClick={() => openNamespaceEditor(null)}>
                        New namespace
                      </Button>
                    </Flex>
                    <List
                      size="small"
                      dataSource={namespaces}
                      locale={{ emptyText: 'No readable namespaces' }}
                      renderItem={(namespace) => {
                        const canManageNamespace = namespace.effective_permission === 'own';
                        return (
                          <List.Item
                            actions={[
                              <Button
                                key="edit"
                                size="small"
                                disabled={!canManageNamespace}
                                onClick={() => openNamespaceEditor(namespace)}
                              >
                                Edit
                              </Button>,
                              <Button
                                key="archive"
                                size="small"
                                danger
                                disabled={!canManageNamespace || namespace.kind === 'system'}
                                onClick={() => archiveNamespace(namespace)}
                              >
                                Archive
                              </Button>,
                            ]}
                          >
                            <List.Item.Meta
                              title={
                                <Space wrap>
                                  <Text strong>{namespace.display_name || namespace.slug}</Text>
                                  <Tag>{namespace.slug}</Tag>
                                  <Tag color={namespace.others_can === 'none' ? 'default' : 'blue'}>
                                    others: {namespace.others_can}
                                  </Tag>
                                </Space>
                              }
                              description={namespace.description || 'No description'}
                            />
                          </List.Item>
                        );
                      }}
                    />
                  </Space>
                ),
              },
              {
                key: 'semantic',
                label: 'Semantic search',
                children: (
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
                        <Form.Item
                          name="provider"
                          label="Provider"
                          style={{ minWidth: 180, flex: 1 }}
                        >
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
                      <Space>
                        <Button onClick={reindexKnowledge} loading={settingsSaving}>
                          Reindex now
                        </Button>
                        <Button
                          type="primary"
                          onClick={saveKnowledgeSettings}
                          loading={settingsSaving}
                        >
                          Save semantic settings
                        </Button>
                      </Space>
                    </Flex>
                  </Space>
                ),
              },
            ]}
          />
        </Spin>
      </Modal>

      <Modal
        title={namespaceEditing ? 'Edit namespace' : 'Create namespace'}
        open={namespaceEditorOpen}
        onCancel={() => setNamespaceEditorOpen(false)}
        okText={namespaceEditing ? 'Save namespace' : 'Create namespace'}
        onOk={saveNamespace}
        confirmLoading={namespaceSaving}
        destroyOnHidden
      >
        <Form form={namespaceForm} layout="vertical" onValuesChange={handleNamespaceValuesChange}>
          <Form.Item
            name="display_name"
            label="Name"
            rules={[{ required: true, message: 'Name is required' }]}
          >
            <Input placeholder="Team docs" />
          </Form.Item>
          <Form.Item
            name="slug"
            label="Slug"
            rules={[
              { required: true, message: 'Namespace slug is required' },
              {
                pattern: /^[a-z0-9][a-z0-9._-]*$/,
                message: 'Use lowercase letters, numbers, dots, underscores, or dashes',
              },
            ]}
          >
            <Input disabled={Boolean(namespaceEditing)} placeholder="team-docs" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={3} placeholder="What belongs in this namespace?" />
          </Form.Item>
          <Form.Item name="kind" hidden>
            <Input />
          </Form.Item>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space direction="vertical" size={0}>
              <Text strong>Default access</Text>
              <Text type="secondary">
                These defaults apply across the namespace before user or group-specific grants.
              </Text>
            </Space>
            <Flex gap={12} wrap="wrap">
              <Form.Item
                name="visibility_default"
                label="Default document visibility"
                style={{ minWidth: 180, flex: 1 }}
              >
                <Select
                  options={[
                    { label: 'Public in namespace', value: 'public' },
                    { label: 'Private to creator', value: 'private' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="others_can"
                label="Everyone else in workspace"
                tooltip="Fallback for users not listed in specific namespace access."
                style={{ minWidth: 180, flex: 1 }}
              >
                <Select
                  options={[
                    { label: 'No access', value: 'none' },
                    { label: 'Read', value: 'read' },
                    { label: 'Write', value: 'write' },
                  ]}
                />
              </Form.Item>
            </Flex>
          </Space>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space direction="vertical" size={0}>
              <Text strong>Specific access</Text>
              <Text type="secondary">
                Add users or groups that should override the default access above.
              </Text>
            </Space>
            <Flex gap={8} wrap="wrap">
              <Select
                showSearch
                allowClear
                placeholder="User or group"
                value={namespaceAclSubject}
                onChange={(value) => setNamespaceAclSubject(value ?? null)}
                options={namespaceAclSubjectOptions}
                optionFilterProp="label"
                style={{ minWidth: 280, flex: 1 }}
              />
              <Select
                value={namespaceAclPermission}
                onChange={setNamespaceAclPermission}
                options={[
                  { label: 'Read', value: 'read' },
                  { label: 'Write', value: 'write' },
                  { label: 'Own', value: 'own' },
                ]}
                style={{ width: 120 }}
              />
              <Button onClick={addNamespaceAclDraftEntry} disabled={!namespaceAclSubject}>
                + Add
              </Button>
            </Flex>
            <Spin spinning={namespaceAclLoading}>
              <List
                size="small"
                dataSource={namespaceAclDraft}
                locale={{ emptyText: 'No specific user or group grants' }}
                renderItem={(entry) => (
                  <List.Item
                    actions={[
                      <Select
                        key="permission"
                        size="small"
                        value={entry.permission}
                        onChange={(permission) =>
                          updateNamespaceAclDraftPermission(entry, permission)
                        }
                        options={[
                          { label: 'Read', value: 'read' },
                          { label: 'Write', value: 'write' },
                          { label: 'Own', value: 'own' },
                        ]}
                        style={{ width: 110 }}
                      />,
                      <Button
                        key="remove"
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={`Remove ${namespaceSubjectLabel(entry)}`}
                        onClick={() => removeNamespaceAclDraftEntry(entry)}
                      />,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Space>
                          <Tooltip title={entry.subject_type === 'user' ? 'User' : 'Group'}>
                            {entry.subject_type === 'user' ? <UserOutlined /> : <TeamOutlined />}
                          </Tooltip>
                          <Text>{namespaceSubjectLabel(entry)}</Text>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </Spin>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="Relocate page"
        open={relocateModalOpen}
        okText="Move"
        onOk={async () => {
          if (activeDoc) await moveDocumentToFolder(activeDoc, relocateFolder);
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
              {...searchableSelectProps}
              value={createNamespace}
              onChange={setCreateNamespace}
              options={namespaceOptions}
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
