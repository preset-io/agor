# File Browser Implementation - Design Document

## Overview

Convert the WorktreeModal's "Concepts" tab into a general-purpose file browser that allows users to browse all files in a worktree, preview text files, and download any file.

## Background

**Current State:**

- `ConceptsTab` component only displays markdown files from the `context/` folder
- Backend `context` service is hardcoded to scan only `context/` directory
- `MarkdownModal` displays markdown content only
- No download functionality exists
- Original purpose (concepts in Agor's information architecture) is no longer relevant

**Target State:**

- `FilesTab` component shows entire worktree file tree
- Smart text file preview for common formats
- Download option for all files
- Size limits to prevent loading huge files
- Rename "context" service to "file" service to reflect actual purpose

## Architecture Analysis

### Current Implementation

#### Frontend Components

- **WorktreeModal** (`apps/agor-ui/src/components/WorktreeModal/WorktreeModal.tsx`)
  - Main modal with tabs: General, Environment, Concepts, Schedule
  - Tab 3 (Concepts) renders `ConceptsTab`

- **ConceptsTab** (`apps/agor-ui/src/components/WorktreeModal/tabs/ConceptsTab.tsx`)
  - Fetches files from `context` service
  - Displays info alert about `context/` directory
  - Uses `FileCollection` for file tree
  - Opens `MarkdownModal` on file click

- **FileCollection** (`apps/agor-ui/src/components/FileCollection/FileCollection.tsx`)
  - Builds hierarchical tree from flat file list
  - Strips `context/` prefix for display (in ConceptsTab)
  - Supports search/filter with auto-expand
  - Handles all file types (text and binary)
  - Sorts directories first, then files alphabetically

- **MarkdownModal** (`apps/agor-ui/src/components/MarkdownModal/MarkdownModal.tsx`)
  - Displays file content in modal (900px width)
  - Uses `MarkdownRenderer` for rendering
  - Removes `context/` prefix from display

- **MarkdownRenderer** (`apps/agor-ui/src/components/MarkdownRenderer/MarkdownRenderer.tsx`)
  - Uses Streamdown library
  - Supports mermaid diagrams, LaTeX, GFM tables
  - Code blocks with syntax highlighting and copy buttons

#### Backend Service

- **Context Service** (`apps/agor-daemon/src/services/context.ts`)
  - Feathers.js service with `find()` and `get()` methods
  - Hardcoded to scan `context/` directory only
  - Only includes `.md` files
  - Path traversal validation (no `..`, must stay within worktree)
  - Returns `ContextFileListItem[]` or `ContextFileDetail`

```typescript
interface ContextFileListItem {
  path: string; // e.g., "context/concepts/core.md"
  title: string; // H1 heading or filename
  size: number; // File size in bytes
  lastModified: string; // ISO 8601 timestamp
}

interface ContextFileDetail extends ContextFileListItem {
  content: string; // Full file content
}
```

#### Existing Related Services

- **Files Service** (`apps/agor-daemon/src/services/files.ts`)
  - General file autocomplete search using `git ls-files`
  - Returns folders + files (max 10 results)
  - Requires `sessionId` + `search` query parameters
  - Not suitable for file browsing UI (autocomplete-focused)

## Design Decisions (FINALIZED)

### Core Intent

- **Quick file browser for convenience** - NOT rebuilding an IDE or git visualizer
- **Snapshot view** - No real-time watching, no collaboration
- **No session caching** - Fresh fetch on every tab open, clean flush on close
- **Excluded scope**: No git history, no bookmarks, no sharing, no mobile support, no file editing

### Load Strategy: Load-All-Upfront with Hard Limit

- **Single API call** to fetch all files when FilesTab opens
- **No caching between sessions** - completely stateless
- **No file watching** - snapshot as of open time
- **Hard limit: 50,000 files** - prevents browser crashes on massive monorepos
- **Friendly degradation**: Show warning alert if limit hit
- **Enables in-memory search** - instant filtering (huge UX win)

### Performance Safeguards

- **antd Tree with virtual scrolling** - renders only visible nodes
- **Exclude large folders** - `node_modules/`, `.git/`, `dist/`, `build/`, etc.
- **Size estimates**:
  - 10k files × 200 bytes = ~2MB JSON (fast)
  - 50k files × 200 bytes = ~10MB JSON (manageable)
  - Browser bottleneck is tree rendering, not data transfer
  - Virtual scrolling handles 50k+ nodes efficiently

### User Experience for Large Repos

```tsx
// If file count exceeds limit
<Alert type="warning" showIcon>
  Woah! Big repo alert! Only {MAX_FILES.toLocaleString()} files were loaded to prevent your browser
  from crashing. Use git/IDE for full repo browsing.
</Alert>;

// If repo is large but under limit
{
  files.length > 10000 && (
    <Alert type="info" showIcon>
      Large repository: {files.length.toLocaleString()} files loaded. Use search to find files
      quickly.
    </Alert>
  );
}
```

## Proposed Changes

### 1. Backend: Rename and Extend Service

**Rename `context` → `file` service:**

**Files to Update:**

- `apps/agor-daemon/src/services/context.ts` → `apps/agor-daemon/src/services/file.ts`
- `packages/core/src/types/context.ts` → `packages/core/src/types/file.ts`
- Update imports in `apps/agor-daemon/src/index.ts` (service registration)
- Update exports in `packages/core/src/types/index.ts`
- Update API client types in `packages/core/src/api/index.ts`

**Rename Types:**

- `ContextFilePath` → `FilePath`
- `ContextFileListItem` → `FileListItem`
- `ContextFileDetail` → `FileDetail`
- `createContextService` → `createFileService`

**Add New Fields to `FileListItem`:**

```typescript
interface FileListItem {
  path: string; // Relative path from worktree root
  title: string; // H1 heading (markdown) or filename
  size: number; // File size in bytes
  lastModified: string; // ISO 8601 timestamp
  isText: boolean; // NEW: whether file is previewable
  mimeType?: string; // NEW: detected MIME type (optional)
}

interface FileDetail extends FileListItem {
  content: string; // Full file content (text or base64 for binary)
}
```

**Add Text Detection Helper:**

```typescript
function isTextFile(filePath: string, size: number): boolean {
  // Size limit: 1MB for preview
  if (size > 1024 * 1024) return false;

  const textExtensions = [
    '.txt',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.py',
    '.rb',
    '.go',
    '.rs',
    '.java',
    '.c',
    '.cpp',
    '.h',
    '.css',
    '.scss',
    '.less',
    '.html',
    '.xml',
    '.svg',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.env',
    '.gitignore',
    '.dockerignore',
    '.sql',
    '.graphql',
    '.proto',
    '.toml',
    '.ini',
    '.vue',
    '.svelte',
    '.astro',
    '.makefile',
    '.dockerfile',
  ];

  return textExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
}

function getMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.py': 'text/x-python',
    '.html': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    // ... add more as needed
  };
  return mimeTypes[ext];
}
```

**Update `find()` Method:**

```typescript
const MAX_FILES = 50000; // Hard limit to prevent browser crashes

async find(params: Params): Promise<FileListItem[]> {
  const { worktree_id } = params.query;
  const worktree = await this.worktreeRepository.getByWorktreeId(worktree_id);

  if (!worktree) {
    throw new Error('Worktree not found');
  }

  const worktreeRoot = worktree.path;

  // Scan entire worktree instead of just context/
  const files = await this.scanDirectory(worktreeRoot, worktreeRoot);

  // Apply hard limit to prevent browser crashes
  if (files.length > MAX_FILES) {
    console.warn(`Repository has ${files.length} files, truncating to ${MAX_FILES}`);
    return files.slice(0, MAX_FILES);
  }

  return files;
}

private async scanDirectory(
  baseDir: string,
  currentDir: string,
  excludePatterns: string[] = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '__pycache__',
    '.venv',
    'venv',
  ]
): Promise<FileListItem[]> {
  const files: FileListItem[] = [];
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    // Skip excluded directories
    if (excludePatterns.some(pattern => relativePath.includes(pattern))) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively scan subdirectories
      const subFiles = await this.scanDirectory(baseDir, fullPath, excludePatterns);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      const stats = await fs.stat(fullPath);
      const isText = isTextFile(relativePath, stats.size);

      files.push({
        path: relativePath,
        title: entry.name, // or extract H1 for .md files
        size: stats.size,
        lastModified: stats.mtime.toISOString(),
        isText,
        mimeType: getMimeType(relativePath),
      });
    }
  }

  return files;
}
```

**Update `get()` Method:**

```typescript
async get(id: string, params: Params): Promise<FileDetail> {
  const { worktree_id } = params.query;
  const worktree = await this.worktreeRepository.getByWorktreeId(worktree_id);

  if (!worktree) {
    throw new Error('Worktree not found');
  }

  // Validate path (prevent traversal attacks)
  if (id.includes('..') || id.startsWith('/')) {
    throw new Error('Invalid file path');
  }

  const filePath = path.join(worktree.path, id);

  // Ensure file is within worktree
  if (!filePath.startsWith(worktree.path)) {
    throw new Error('Access denied');
  }

  const stats = await fs.stat(filePath);
  const content = await fs.readFile(filePath, 'utf-8');
  const isText = isTextFile(id, stats.size);

  return {
    path: id,
    title: path.basename(id),
    size: stats.size,
    lastModified: stats.mtime.toISOString(),
    isText,
    mimeType: getMimeType(id),
    content,
  };
}
```

**Service Registration Update (`apps/agor-daemon/src/index.ts`):**

```typescript
// Before:
// app.use('/context', createContextService(worktreeRepository));

// After:
import { createFileService } from './services/file';

// Register file service (filesystem browser for worktree files)
// Scans entire worktree for all files recursively
// Requires worktree_id query parameter
const worktreeRepository = new WorktreeRepository(db);
app.use('/file', createFileService(worktreeRepository));
```

### 2. Frontend: Rename and Update Components

**Rename Components:**

- `ConceptsTab.tsx` → `FilesTab.tsx`
- Update component name: `ConceptsTab` → `FilesTab`
- Update props interface: `ConceptsTabProps` → `FilesTabProps`

**Update FileCollection:**

- Remove hardcoded `context/` prefix stripping
- Keep generic, works for any file tree

**Update FilesTab.tsx:**

```typescript
import { useState, useEffect } from 'react';
import { Alert, Spin, message, Button } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import type { Worktree } from '@agor/core';
import type { AgorClient } from '@agor/core/api';
import { FileCollection } from '../../FileCollection/FileCollection';
import { MarkdownModal } from '../../MarkdownModal/MarkdownModal';
import { CodePreviewModal } from '../../CodePreviewModal/CodePreviewModal';
import type { FileListItem, FileDetail } from '@agor/core/types/file';

export interface FilesTabProps {
  worktree: Worktree;
  client: AgorClient | null;
}

export const FilesTab = ({ worktree, client }: FilesTabProps) => {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (client && worktree) {
      fetchFiles();
    }
  }, [client, worktree]);

  const fetchFiles = async () => {
    if (!client) return;

    try {
      setLoading(true);
      setError(null);

      const result = await client.service('file').find({
        query: { worktree_id: worktree.worktree_id },
      });

      const data = Array.isArray(result) ? result : result.data;
      setFiles(data);
    } catch (err) {
      console.error('Failed to fetch files:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleFileClick = async (file: FileListItem) => {
    if (!client) return;

    // If text file under size limit, preview in modal
    if (file.isText && file.size < 1024 * 1024) {
      try {
        setLoadingDetail(true);
        setModalOpen(true);

        const detail = await client.service('file').get(file.path, {
          query: { worktree_id: worktree.worktree_id },
        });

        setSelectedFile(detail);
      } catch (err) {
        console.error('Failed to fetch file detail:', err);
        message.error('Failed to load file');
        setModalOpen(false);
      } finally {
        setLoadingDetail(false);
      }
    } else {
      // Download file directly
      downloadFile(file);
    }
  };

  const downloadFile = async (file: FileListItem) => {
    if (!client) return;

    try {
      message.loading({ content: 'Downloading file...', key: 'download' });

      const detail = await client.service('file').get(file.path, {
        query: { worktree_id: worktree.worktree_id },
      });

      const blob = new Blob([detail.content], {
        type: file.mimeType || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.path.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      message.success({ content: 'Downloaded!', key: 'download' });
    } catch (err) {
      console.error('Failed to download file:', err);
      message.error({ content: 'Failed to download file', key: 'download' });
    }
  };

  const handleCloseModal = () => {
    setModalOpen(false);
    setSelectedFile(null);
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        type="error"
        message="Failed to load files"
        description={error}
        showIcon
      />
    );
  }

  const isMarkdown = selectedFile?.path.endsWith('.md');
  const MAX_FILES = 50000;
  const isTruncated = files.length >= MAX_FILES;

  return (
    <div>
      {isTruncated && (
        <Alert
          type="warning"
          message="Woah! Big repo alert!"
          description={`Only ${MAX_FILES.toLocaleString()} files were loaded to prevent your browser from crashing. Use git/IDE for full repo browsing.`}
          showIcon
          style={{ marginBottom: '1rem' }}
        />
      )}

      {!isTruncated && files.length > 10000 && (
        <Alert
          type="info"
          message={`Large repository: ${files.length.toLocaleString()} files loaded.`}
          description="Use search to find files quickly."
          showIcon
          style={{ marginBottom: '1rem' }}
        />
      )}

      <Alert
        type="info"
        message={`Browsing all files in worktree: ${worktree.worktree_name}`}
        description="Click text files to preview, or download any file."
        showIcon
        style={{ marginBottom: '1rem' }}
      />

      <FileCollection
        files={files}
        onFileClick={handleFileClick}
        onDownload={downloadFile}
      />

      {isMarkdown ? (
        <MarkdownModal
          file={selectedFile}
          open={modalOpen}
          onClose={handleCloseModal}
          loading={loadingDetail}
        />
      ) : (
        <CodePreviewModal
          file={selectedFile}
          open={modalOpen}
          onClose={handleCloseModal}
          loading={loadingDetail}
        />
      )}
    </div>
  );
};
```

**Update WorktreeModal.tsx:**

```typescript
// Replace Concepts tab import and usage
import { FilesTab } from './tabs/FilesTab';

// ...

{
  key: 'files',
  label: 'Files',
  children: <FilesTab worktree={worktree} client={client} />,
}
```

### 3. Add Download Functionality

**Update FileCollection to show download button:**

```typescript
// In buildTree(), update TreeNode title rendering for leaf nodes
if (isLeaf) {
  const displayTitle = file.title || fileName;
  return {
    key: file.path,
    title: (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          width: '100%',
        }}
      >
        <span>{displayTitle}</span>
        <Button
          size="small"
          type="text"
          icon={<DownloadOutlined />}
          onClick={(e) => {
            e.stopPropagation();
            onDownload?.(file);
          }}
          style={{ marginLeft: '0.5rem' }}
        />
      </div>
    ),
    icon: <FileMarkdownOutlined />,
    isLeaf: true,
    file,
  };
}
```

**Update FileCollection props:**

```typescript
export interface FileCollectionProps {
  files: FileListItem[];
  onFileClick: (file: FileListItem) => void;
  onDownload?: (file: FileListItem) => void; // NEW
}
```

**Enable virtual scrolling for performance:**

```typescript
// In FileCollection.tsx, update the Tree component
<Tree
  treeData={treeData}
  onSelect={handleSelect}
  showIcon
  expandedKeys={expandedKeys}
  onExpand={handleExpand}
  // NEW: Enable virtual scrolling for 50k+ files
  virtual
  height={600}  // Fixed height enables virtualization
  // Don't auto-expand everything (kills performance)
  defaultExpandedKeys={[]}
/>
```

This enables **virtual scrolling** which renders only visible tree nodes, making it performant even with 50,000 files.

### 4. Add Code Preview Modal

**Create new component: `CodePreviewModal.tsx`**

```typescript
import { Modal } from 'antd';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { FileDetail } from '@agor/core/types/file';

export interface CodePreviewModalProps {
  file: FileDetail | null;
  open: boolean;
  onClose: () => void;
  loading?: boolean;
}

const getLanguageFromPath = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    sql: 'sql',
    graphql: 'graphql',
    proto: 'protobuf',
    toml: 'toml',
    vue: 'vue',
    svelte: 'svelte',
  };
  return languageMap[ext || ''] || 'text';
};

export const CodePreviewModal = ({
  file,
  open,
  onClose,
  loading,
}: CodePreviewModalProps) => {
  if (!file) return null;

  const language = getLanguageFromPath(file.path);

  return (
    <Modal
      title={file.path}
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      styles={{
        body: {
          maxHeight: '70vh',
          overflow: 'auto',
        },
      }}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          Loading...
        </div>
      ) : (
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: '4px',
          }}
        >
          {file.content}
        </SyntaxHighlighter>
      )}
    </Modal>
  );
};
```

**Add dependency to `package.json`:**

```json
{
  "dependencies": {
    "react-syntax-highlighter": "^15.5.0"
  },
  "devDependencies": {
    "@types/react-syntax-highlighter": "^15.5.11"
  }
}
```

## Security Considerations

**Already Handled:**

- ✅ Path traversal validation (no `..` in paths)
- ✅ Worktree isolation (can't access files outside worktree)
- ✅ Authentication (requires worktree_id)

**New Considerations:**

- ✅ Size limits: Don't load files > 1MB into memory for preview
- ✅ Binary files: Mark as non-previewable with `isText: false`
- ✅ Excluded directories: Skip `node_modules/`, `.git/`, etc.
- ⚠️ Sensitive files: Consider warning for `.env`, private keys, etc.

## Performance Considerations

**Potential Issues:**

- Large repos (10k+ files) might make tree slow to render
- Initial load could be slow for massive repos

**Mitigations:**

1. **Exclusion list**: Filter out `node_modules/`, `.git/`, `dist/`, `build/` by default
2. **Limit file count**: Show first 5000 files, add "some files hidden" message
3. **Backend caching**: Cache file list, invalidate on git events (future)
4. **Virtual scrolling**: Use `rc-virtual-list` for tree rendering (future)
5. **Lazy loading**: Only expand/load children on click (future)

**For MVP:**

- Simple exclusion list for common large folders
- If tree has > 5000 files, show warning message
- Optimize later based on actual usage

## Migration Strategy

### Phase 1: Backend Migration

1. Copy `context.ts` → `file.ts` in services folder
2. Update type definitions: `context.ts` → `file.ts` in core types
3. Rename all types and functions
4. Update service registration in daemon index
5. Add new fields (`isText`, `mimeType`)
6. Update `find()` to scan entire worktree
7. Add exclusion logic
8. Test with curl/Postman

### Phase 2: Frontend Migration

1. Copy `ConceptsTab.tsx` → `FilesTab.tsx`
2. Update imports to use new `file` service and types
3. Update UI text and alerts
4. Add download functionality
5. Create `CodePreviewModal` component
6. Update `WorktreeModal` to use `FilesTab`
7. Test in browser

### Phase 3: Cleanup

1. Delete old `ConceptsTab.tsx` (after verifying FilesTab works)
2. Deprecate old `context` service (keep for backward compatibility initially)
3. Update any other components using context service
4. Remove deprecated code in next major version

## Implementation Decisions (FINALIZED)

### 1. Service Migration Strategy

**Decision:** Keep both `context` and `file` services temporarily for safety

- Migrate frontend to use `file` service
- Deprecate `context` service with console warnings
- Remove `context` in next major version after migration period

### 2. Binary File Handling

**Decision:** Always force download for MVP

- Binary files trigger download instead of preview
- Future: Add image preview for jpg/png/svg in modal

### 3. Large File Threshold

**Decision:** 1MB limit for preview vs download

- Files > 1MB automatically download
- Prevents browser memory issues
- Can make configurable later if needed

### 4. Excluded Directories

**Decision:** Hardcoded exclusion list for MVP

- Exclude: `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `coverage/`, `__pycache__/`, `.venv/`, `venv/`
- Future: Add `.gitignore` support for smarter exclusions

### 5. File Tree Performance

**Decision:** Load all files + virtual scrolling + 50k hard limit

- Hard limit: 50,000 files (truncate with warning if exceeded)
- antd Tree with `virtual={true}` for rendering performance
- Show warning alert for repos > 10k files
- Search works instantly on loaded files (in-memory)

### 6. File Type Icons

**Decision:** Keep existing basic icons (folder/file)

- Already using FolderOutlined and FileMarkdownOutlined
- Future: Add full icon set for polish (vscode-icons)

### 7. Download Implementation

**Decision:** Fetch content + blob creation in browser

- Reuse existing `get()` endpoint
- Create blob client-side, trigger download
- Simple, works for any file size
- Future: Consider dedicated streaming endpoint for very large files

### 8. Sensitive File Warning

**Decision:** No warnings for MVP

- Don't overcomplicate initial version
- Files are already protected by worktree auth
- Future: Add visual indicator for `.env`, `.pem`, `.key` files

### 9. Context Folder Backward Compatibility

**Decision:** No special treatment for `context/` folder

- Treat as regular folder in tree
- Simplifies implementation
- Users can still navigate to it if needed

### 10. Edit Functionality

**Decision:** Read-only for MVP (out of scope)

- File browser is for quick viewing, not editing
- Not rebuilding an IDE
- Users should use actual IDE/editor for changes

---

## Testing Checklist

**Backend Tests:**

- [ ] List files in small repo (< 100 files)
- [ ] List files in medium repo (100-1000 files)
- [ ] List files in large repo (1000+ files)
- [ ] Excluded directories are filtered correctly
- [ ] Path traversal attack prevention works
- [ ] Text detection works for various file types
- [ ] MIME type detection works
- [ ] File content fetching works
- [ ] Error handling for missing files
- [ ] Error handling for invalid worktree_id

**Frontend Tests:**

- [ ] Tree renders correctly with files
- [ ] Tree search/filter works
- [ ] Folder expand/collapse works
- [ ] Click text file opens preview modal
- [ ] Click binary file triggers download
- [ ] Markdown preview renders correctly
- [ ] Code preview renders with syntax highlighting
- [ ] Download button works for all files
- [ ] Large file (> 1MB) triggers download instead of preview
- [ ] Modal close button works
- [ ] Loading states display correctly
- [ ] Error states display correctly

**Cross-browser Tests:**

- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari

**Edge Cases:**

- [ ] Empty worktree (no files)
- [ ] Single file
- [ ] Deeply nested folders (10+ levels)
- [ ] Special characters in filenames
- [ ] Very long filenames
- [ ] Symbolic links (how to handle?)
- [ ] Hidden files (`.gitignore`, `.env`)

## Success Criteria

**MVP Success:**

- ✅ User can browse all files in worktree
- ✅ User can preview text files < 1MB
- ✅ User can download any file
- ✅ Common large folders are excluded (node_modules, .git)
- ✅ Tree loads in < 3 seconds for repos with < 1000 files
- ✅ No regression in existing functionality

**Future Enhancements:**

- Image preview in modal
- Respect `.gitignore` patterns
- Virtual scrolling for large trees
- Edit file functionality
- "Open in VS Code" button
- File type icons
- Breadcrumb navigation
- Keyboard shortcuts (arrow keys, enter to open)

## Timeline Estimate

**Backend (2-3 hours):**

- Rename and update service: 1 hour
- Add exclusion logic: 30 min
- Test and debug: 1 hour

**Frontend (3-4 hours):**

- Rename components and update imports: 30 min
- Update FilesTab with new logic: 1 hour
- Create CodePreviewModal: 1 hour
- Add download functionality: 30 min
- Test and debug: 1 hour

**Total: 5-7 hours** for MVP implementation

## Implementation Sequence

1. ✅ Create design document (this file)
2. Backend: Create `file.ts` service (keep `context.ts` for now)
3. Backend: Update types in `packages/core`
4. Backend: Register new service in daemon
5. Backend: Test with API client
6. Frontend: Create `FilesTab.tsx` (keep `ConceptsTab.tsx` for now)
7. Frontend: Create `CodePreviewModal.tsx`
8. Frontend: Update `WorktreeModal.tsx` to use FilesTab
9. Frontend: Test in browser
10. Integration testing
11. Cleanup: Remove old components and service
12. Documentation update

## File Actions (MVP Features)

### Primary Actions

**1. View in Browser**

- **Markdown files** (.md, .mdx): Use existing `MarkdownModal` with Streamdown
  - Automatic code block highlighting via Shiki
  - Mermaid diagrams, LaTeX math, GFM tables
  - Copy buttons on code blocks
- **Code files** (.js, .ts, .py, etc.): Use new `CodePreviewModal` with react-syntax-highlighter
  - Prism.js highlighting for 100+ languages
  - Line numbers, oneDark theme
  - Auto-detect language from file extension
- **Large files** (> 1MB): Skip preview, trigger download
- **Binary files**: Trigger download

**2. Download**

- Client-side blob creation (no endpoint needed!)
- Reuses existing `service.get()` endpoint
- Works for all file types
- Shows success toast on download

**3. Expand/Collapse Folders**

- Built-in antd Tree functionality
- Virtual scrolling for performance
- Search auto-expands matching paths

### Quick Win Actions (5-10 min each)

**4. Copy File Path** 🔥

```tsx
<Button
  icon={<CopyOutlined />}
  size="small"
  onClick={() => {
    navigator.clipboard.writeText(file.path);
    message.success('Path copied!');
  }}
/>
```

- Show on each file in tree (inline with download button)
- Huge value for developers

**5. Copy File Content** 🔥

```tsx
// In preview modal footer
<Button
  icon={<CopyOutlined />}
  onClick={() => {
    navigator.clipboard.writeText(file.content);
    message.success('Content copied!');
  }}
>
  Copy Content
</Button>
```

- Only in preview modals (not for files that auto-download)
- Lets users quickly grab code snippets

### Future Enhancements (Not MVP)

- File metadata tooltips (size, date modified)
- Context menu (right-click)
- Raw URL for sharing
- Image preview for .jpg/.png/.svg
- Open in VS Code button

---

## Quick Reference: Key Technical Specs

**Hard Limits:**

- Max files loaded: **50,000** (truncate with warning)
- Max file size for preview: **1MB** (larger files auto-download)
- Excluded folders: `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `__pycache__`, `.venv`, `venv`

**Performance:**

- Load strategy: **Load-all-upfront** (single API call)
- Caching: **None** (fresh fetch on tab open, flush on close)
- Tree rendering: **Virtual scrolling** (`virtual={true}`, `height={600}`)
- Search: **In-memory** (instant filtering)

**User Experience:**

- 50k+ files: "Woah! Big repo alert!" (warning)
- 10k-50k files: "Large repository" (info)
- Text files < 1MB: Preview in modal
- Binary/large files: Download directly
- No file watching, no real-time updates

**Service Rename:**

- `context` → `file` service
- `ContextFileListItem` → `FileListItem`
- `ContextFileDetail` → `FileDetail`
- Keep old `context` service temporarily, deprecate gradually

**Components:**

- `ConceptsTab` → `FilesTab`
- New: `CodePreviewModal` (syntax highlighting)
- Rename: `MarkdownFileCollection` → `FileCollection` (handles all file types)
- Update: `FileCollection` (add download button, virtual scrolling, binary file support)
- Reuse: `MarkdownModal` (for .md files)

---

## References

**Existing Code:**

- WorktreeModal: `apps/agor-ui/src/components/WorktreeModal/WorktreeModal.tsx`
- ConceptsTab: `apps/agor-ui/src/components/WorktreeModal/tabs/ConceptsTab.tsx`
- Context Service: `apps/agor-daemon/src/services/context.ts`
- Context Types: `packages/core/src/types/context.ts`

**Dependencies:**

- Feathers.js: https://feathersjs.com/
- react-syntax-highlighter: https://github.com/react-syntax-highlighter/react-syntax-highlighter
- Ant Design Tree: https://ant.design/components/tree
- Ant Design: https://ant.design/

**Related Features:**

- Files Service (autocomplete): `apps/agor-daemon/src/services/files.ts`
- MarkdownRenderer: `apps/agor-ui/src/components/MarkdownRenderer/MarkdownRenderer.tsx`
