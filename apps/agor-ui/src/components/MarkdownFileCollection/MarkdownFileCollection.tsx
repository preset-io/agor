/**
 * MarkdownFileCollection - Reusable tree view for browsing markdown files
 *
 * Features:
 * - Tree view with nested folders
 * - Shows file path + title
 * - Click handler for opening files
 * - Loading and empty states
 * - Search/filter capability
 */

import { FileMarkdownOutlined, FolderOutlined } from '@ant-design/icons';
import { Empty, Input, Spin, Tree, Typography } from 'antd';
import type React from 'react';
import { useMemo, useState } from 'react';
import type { ConceptListItem } from '../../types';

const { Search } = Input;

export interface MarkdownFileCollectionProps {
  /** List of markdown files from server */
  files: ConceptListItem[];

  /** Callback when file is clicked */
  onFileClick: (file: ConceptListItem) => void;

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
  file?: ConceptListItem; // Attached for leaf nodes
}

/**
 * Build tree structure from flat file list
 * Groups files by directory, preserving hierarchy
 */
function buildTree(files: ConceptListItem[], searchQuery: string): TreeNode[] {
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
    // Strip "context/" prefix from path for display
    const displayPath = file.path.replace(/^context\//, '');
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
          title: part,
          icon: <FolderOutlined />,
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

    // Add file node
    const fileNode: TreeNode = {
      key: file.path,
      title: (
        <span>
          <Typography.Text strong>{file.title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            ({displayPath})
          </Typography.Text>
        </span>
      ),
      icon: <FileMarkdownOutlined />,
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

export const MarkdownFileCollection: React.FC<MarkdownFileCollectionProps> = ({
  files,
  onFileClick,
  loading = false,
  emptyMessage = 'No markdown files found',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  // Build tree structure
  const treeData = useMemo(() => buildTree(files, searchQuery), [files, searchQuery]);

  // Handle node selection
  const handleSelect = (_selectedKeys: React.Key[], info: { node: TreeNode }) => {
    if (info.node.isLeaf && info.node.file) {
      onFileClick(info.node.file);
    }
  };

  // Handle search - expand all matching paths
  const handleSearch = (value: string) => {
    setSearchQuery(value);

    if (value) {
      // Expand all directories when searching
      const allKeys = getAllKeys(treeData);
      setExpandedKeys(allKeys);
    } else {
      // Collapse all when clearing search
      setExpandedKeys([]);
    }
  };

  // Get all directory keys for expansion
  const getAllKeys = (nodes: TreeNode[]): string[] => {
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
          onSearch={handleSearch}
          onChange={(e) => !e.target.value && handleSearch('')}
          style={{ width: '100%' }}
        />
      </div>

      <Tree
        treeData={treeData}
        onSelect={handleSelect}
        showIcon
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys as string[])}
        style={{ background: 'transparent' }}
      />
    </div>
  );
};
