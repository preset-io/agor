/**
 * FileCollection - Reusable tree view for browsing files
 *
 * Features:
 * - Tree view with nested folders
 * - Shows file path + title
 * - Click handler for opening files
 * - Loading and empty states
 * - Search/filter capability
 * - Download button for each file
 * - Copy path button for each file
 * - Virtual scrolling for performance
 * - Supports all file types (text and binary)
 */

import type { GitFileStatus } from '@agor-live/client';
import {
  CopyOutlined,
  DownloadOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import type { GlobalToken } from 'antd';
import { Button, Empty, Input, Spin, Tooltip, Tree, theme } from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyToClipboard } from '../../utils/clipboard';
import { useThemedMessage } from '../../utils/message';

const { Search } = Input;

// Debounce delay for live search (milliseconds)
const SEARCH_DEBOUNCE_MS = 300;

export type FileItem = {
  path: string;
  title: string;
  size: number;
  lastModified: string;
  isText?: boolean;
  mimeType?: string;
  gitStatus?: GitFileStatus;
};

/** VSCode-style badge letter + theme color for each git status. */
interface GitStatusMeta {
  color: string;
  letter: string;
  label: string;
}

/**
 * Map each git status to a theme-token color + single-letter badge, matching
 * the VSCode / IDE source-control vocabulary. Colors come from `theme.useToken()`
 * so they adapt to light and dark automatically.
 */
function buildGitStatusMeta(token: GlobalToken): Record<GitFileStatus, GitStatusMeta> {
  return {
    added: { color: token.colorSuccess, letter: 'A', label: 'Added' },
    untracked: { color: token.colorSuccess, letter: 'U', label: 'Untracked' },
    copied: { color: token.colorSuccess, letter: 'C', label: 'Copied' },
    modified: { color: token.colorWarning, letter: 'M', label: 'Modified' },
    renamed: { color: token.colorInfo, letter: 'R', label: 'Renamed' },
    deleted: { color: token.colorError, letter: 'D', label: 'Deleted' },
    conflicted: { color: token.colorError, letter: '!', label: 'Conflicted' },
    ignored: { color: token.colorTextTertiary, letter: 'I', label: 'Ignored' },
  };
}

// Folder tint severity: a directory is colored by its most significant
// descendant change. `ignored` is excluded so ignored subtrees stay neutral.
const GIT_STATUS_SEVERITY: Record<GitFileStatus, number> = {
  conflicted: 7,
  deleted: 6,
  modified: 5,
  renamed: 4,
  added: 3,
  copied: 2,
  untracked: 1,
  ignored: 0,
};

export interface FileCollectionProps {
  /** List of files from server */
  files: FileItem[];

  /** Callback when file is clicked */
  onFileClick: (file: FileItem) => void;

  /** Callback when download button is clicked (optional) */
  onDownload?: (file: FileItem) => void;

  /** Loading state */
  loading?: boolean;

  /** Message to show when no files found */
  emptyMessage?: string;
}

/**
 * Tree node data structure
 */
interface TreeNode {
  key: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  isLeaf?: boolean;
  children?: TreeNode[];
  file?: FileItem; // Attached for leaf nodes
}

/**
 * Build tree structure from flat file list
 * Groups files by directory, preserving hierarchy
 */
function buildTree(
  files: FileItem[],
  searchQuery: string,
  statusMeta: Record<GitFileStatus, GitStatusMeta>,
  onDownload?: (file: FileItem) => void,
  onCopyPath?: (file: FileItem) => void
): TreeNode[] {
  // Filter files by search query
  const filteredFiles = searchQuery
    ? files.filter(
        (f) =>
          f.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          f.path.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : files;

  // Aggregate each directory's most-significant descendant change so folders
  // containing edits can be tinted like an IDE explorer. `ignored` is skipped.
  const dirStatus = new Map<string, GitFileStatus>();
  for (const file of filteredFiles) {
    if (!file.gitStatus || file.gitStatus === 'ignored') continue;
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const current = dirStatus.get(dir);
      if (!current || GIT_STATUS_SEVERITY[file.gitStatus] > GIT_STATUS_SEVERITY[current]) {
        dirStatus.set(dir, file.gitStatus);
      }
    }
  }

  // Group files by directory
  const tree: Map<string, TreeNode> = new Map();

  for (const file of filteredFiles) {
    // Use path as-is (no prefix stripping)
    const displayPath = file.path;
    const parts = displayPath.split('/');

    // Build directory structure
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const parentPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      // Create directory node if it doesn't exist
      if (!tree.has(currentPath)) {
        const folderStatus = dirStatus.get(currentPath);
        const folderColor = folderStatus ? statusMeta[folderStatus].color : undefined;
        tree.set(currentPath, {
          key: currentPath,
          title: (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: folderColor }}
            >
              <FolderOutlined />
              <strong>{part}</strong>
            </span>
          ),
          isLeaf: false,
          children: [],
        });

        // Link to parent if exists
        if (parentPath && tree.has(parentPath)) {
          const parent = tree.get(parentPath)!;
          parent.children = parent.children || [];
          parent.children.push(tree.get(currentPath)!);
        }
      }
    }

    // Determine file icon based on type
    const isMarkdown = file.path.endsWith('.md');
    const FileIcon = isMarkdown ? FileMarkdownOutlined : FileOutlined;

    // Add file node with action buttons
    const fileName = parts[parts.length - 1];

    // Format file size for tooltip
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const fileSize = formatSize(file.size);
    const meta = file.gitStatus ? statusMeta[file.gitStatus] : undefined;
    const isDeleted = file.gitStatus === 'deleted';
    const tooltipText = meta
      ? `${file.path} — ${meta.label}${isDeleted ? '' : ` (${fileSize})`}`
      : `${file.path} (${fileSize})`;

    const fileNode: TreeNode = {
      key: file.path,
      title: (
        <Tooltip title={tooltipText} mouseEnterDelay={0.5}>
          <div
            style={{
              display: 'inline-flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              width: '100%',
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                color: meta?.color,
                textDecoration: isDeleted ? 'line-through' : undefined,
              }}
            >
              <FileIcon />
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {fileName}
              </span>
              {meta && (
                <span
                  role="img"
                  aria-label={meta.label}
                  style={{
                    color: meta.color,
                    fontFamily: 'monospace',
                    fontWeight: 600,
                    fontSize: 12,
                    lineHeight: 1,
                    textDecoration: 'none',
                  }}
                >
                  {meta.letter}
                </span>
              )}
            </span>
            <span style={{ marginLeft: 8, whiteSpace: 'nowrap', display: 'inline-flex', gap: 4 }}>
              <Tooltip title="Copy path">
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onCopyPath) {
                      onCopyPath(file);
                    }
                  }}
                />
              </Tooltip>
              {onDownload && (
                <Tooltip title="Download file">
                  <Button
                    size="small"
                    type="text"
                    icon={<DownloadOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(file);
                    }}
                  />
                </Tooltip>
              )}
            </span>
          </div>
        </Tooltip>
      ),
      isLeaf: true,
      file,
    };

    // Link file to parent directory
    if (currentPath && tree.has(currentPath)) {
      const parent = tree.get(currentPath)!;
      parent.children = parent.children || [];
      parent.children.push(fileNode);
    } else {
      // Root-level file (no directory)
      tree.set(file.path, fileNode);
    }
  }

  // Return only root-level nodes (no parent)
  const roots: TreeNode[] = [];
  const allPaths = new Set(tree.keys());

  for (const [path, node] of tree.entries()) {
    const parentPath = path.split('/').slice(0, -1).join('/');
    if (!parentPath || !allPaths.has(parentPath)) {
      roots.push(node);
    }
  }

  // Sort function: directories first, then files, alphabetically within each group
  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    // Separate directories and files
    const directories = nodes.filter((n) => !n.isLeaf);
    const files = nodes.filter((n) => n.isLeaf);

    // Sort each group alphabetically by key
    directories.sort((a, b) => a.key.localeCompare(b.key));
    files.sort((a, b) => a.key.localeCompare(b.key));

    // Recursively sort children
    directories.forEach((dir) => {
      if (dir.children) {
        dir.children = sortNodes(dir.children);
      }
    });

    // Return directories first, then files
    return [...directories, ...files];
  };

  return sortNodes(roots);
}

const FileCollectionInner: React.FC<FileCollectionProps> = ({
  files,
  onFileClick,
  onDownload,
  loading = false,
  emptyMessage = 'No files found',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const { showSuccess } = useThemedMessage();
  const { token } = theme.useToken();
  const statusMeta = useMemo(() => buildGitStatusMeta(token), [token]);

  // Use refs to store stable callback references
  const onDownloadRef = useRef(onDownload);
  onDownloadRef.current = onDownload;

  const onFileClickRef = useRef(onFileClick);
  onFileClickRef.current = onFileClick;

  // Ref to track debounce timer
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref to track if we should auto-expand on next treeData change (only after search input changes)
  const pendingSearchExpandRef = useRef<string | null>(null);

  // Handle copy path - stable callback
  const handleCopyPath = useCallback(
    async (file: FileItem) => {
      await copyToClipboard(file.path);
      showSuccess('Path copied to clipboard!');
    },
    [showSuccess]
  );

  // Stable wrapper for onDownload
  const stableOnDownload = useCallback((file: FileItem) => {
    onDownloadRef.current?.(file);
  }, []);

  // Build tree structure - only depends on files, searchQuery, status colors,
  // and stable callbacks
  const treeData = useMemo(
    () => buildTree(files, searchQuery, statusMeta, stableOnDownload, handleCopyPath),
    [files, searchQuery, statusMeta, stableOnDownload, handleCopyPath]
  );

  // Handle node selection - stable callback using ref
  const handleSelect = useCallback((_selectedKeys: React.Key[], info: { node: TreeNode }) => {
    if (info.node.isLeaf && info.node.file) {
      onFileClickRef.current(info.node.file);
    }
  }, []);

  // Get all directory keys for expansion
  const getAllKeys = useCallback((nodes: TreeNode[]): string[] => {
    const keys: string[] = [];
    const traverse = (node: TreeNode) => {
      if (!node.isLeaf) {
        keys.push(node.key);
      }
      if (node.children) {
        node.children.forEach(traverse);
      }
    };
    nodes.forEach(traverse);
    return keys;
  }, []);

  // Handle search input change with debounce
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchInput(value);

    // Clear any pending debounce
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Debounce the actual search query update
    debounceTimerRef.current = setTimeout(() => {
      setSearchQuery(value);
      // Mark that we need to expand/collapse after treeData updates
      pendingSearchExpandRef.current = value;
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  // Handle explicit search button click
  const handleSearch = useCallback((value: string) => {
    // Clear any pending debounce
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    setSearchInput(value);
    setSearchQuery(value);
    pendingSearchExpandRef.current = value;
  }, []);

  // Cleanup debounce timer on unmount to prevent setState after unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Handle expansion after treeData changes due to search
  // Using useEffect to avoid state updates during render (React StrictMode warning)
  const prevTreeDataRef = useRef(treeData);
  useEffect(() => {
    if (prevTreeDataRef.current !== treeData && pendingSearchExpandRef.current !== null) {
      const searchValue = pendingSearchExpandRef.current;
      pendingSearchExpandRef.current = null;

      if (searchValue) {
        // Expand all directories when searching
        const allKeys = getAllKeys(treeData);
        // Only update if keys actually changed to avoid unnecessary re-renders
        setExpandedKeys((currentKeys) => {
          if (
            allKeys.length !== currentKeys.length ||
            !allKeys.every((k) => currentKeys.includes(k))
          ) {
            return allKeys;
          }
          return currentKeys;
        });
      } else {
        // Collapse all when clearing search (only if not already collapsed)
        setExpandedKeys((currentKeys) => (currentKeys.length > 0 ? [] : currentKeys));
      }
    }
    prevTreeDataRef.current = treeData;
  }, [treeData, getAllKeys]);

  // Handle expand/collapse - this is the user's manual expansion, don't reset it
  const handleExpand = useCallback((keys: React.Key[]) => {
    setExpandedKeys(keys as string[]);
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!loading && files.length === 0) {
    return (
      <div style={{ padding: 48 }}>
        <Empty description={emptyMessage} />
      </div>
    );
  }

  return (
    <div style={{ padding: '0 24px' }}>
      <div style={{ marginBottom: 16 }}>
        <Search
          placeholder="Search files..."
          allowClear
          value={searchInput}
          onSearch={handleSearch}
          onChange={handleSearchChange}
          style={{ width: '100%' }}
        />
      </div>

      <Tree
        className="agor-flat-tree"
        treeData={treeData}
        onSelect={handleSelect}
        showIcon={false}
        expandedKeys={expandedKeys}
        onExpand={handleExpand}
        style={{ background: 'transparent', borderRadius: 0, padding: 0 }}
        virtual
        height={600}
      />
    </div>
  );
};

// Memoize the component to prevent re-renders when parent re-renders with same props
export const FileCollection = memo(FileCollectionInner, (prevProps, nextProps) => {
  // Custom comparison - only re-render if these specific props changed
  return (
    prevProps.loading === nextProps.loading &&
    prevProps.emptyMessage === nextProps.emptyMessage &&
    prevProps.files === nextProps.files
    // Note: we intentionally don't compare onFileClick and onDownload
    // since we use refs internally to always get the latest callback
  );
});
