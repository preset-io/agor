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

import {
  CopyOutlined,
  DownloadOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FolderOutlined,
} from '@ant-design/icons';
import { Button, Empty, Input, Spin, Tooltip, Tree } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConceptListItem } from '../../types';
import { useThemedMessage } from '../../utils/message';

const { Search } = Input;

// Debounce delay for live search (milliseconds)
const SEARCH_DEBOUNCE_MS = 300;

// Support both old ContextFileListItem and new FileListItem types
export type FileItem =
  | ConceptListItem
  | {
      path: string;
      title: string;
      size: number;
      lastModified: string;
      isText?: boolean;
      mimeType?: string;
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
        tree.set(currentPath, {
          key: currentPath,
          title: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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
    const tooltipText = `${file.path} (${fileSize})`;

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
              style={{ flex: 1, minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <FileIcon />
              {fileName}
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

export const FileCollection: React.FC<FileCollectionProps> = ({
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

  // Handle copy path
  const handleCopyPath = useCallback(
    (file: FileItem) => {
      navigator.clipboard.writeText(file.path);
      showSuccess('Path copied to clipboard!');
    },
    [showSuccess]
  );

  // Build tree structure
  const treeData = useMemo(
    () => buildTree(files, searchQuery, onDownload, handleCopyPath),
    [files, searchQuery, onDownload, handleCopyPath]
  );

  // Handle node selection
  const handleSelect = (_selectedKeys: React.Key[], info: { node: TreeNode }) => {
    if (info.node.isLeaf && info.node.file) {
      onFileClick(info.node.file);
    }
  };

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

  // Debounced search effect
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(searchInput);

      if (searchInput) {
        // Expand all directories when searching
        const allKeys = getAllKeys(treeData);
        setExpandedKeys(allKeys);
      } else {
        // Collapse all when clearing search
        setExpandedKeys([]);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [searchInput, treeData, getAllKeys]);

  // Handle search input change (live filtering with debounce)
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
  };

  // Handle explicit search button click
  const handleSearch = (value: string) => {
    setSearchInput(value);
  };

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
        treeData={treeData}
        onSelect={handleSelect}
        showIcon={false}
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys as string[])}
        style={{ background: 'transparent' }}
        virtual
        height={600}
      />
    </div>
  );
};
