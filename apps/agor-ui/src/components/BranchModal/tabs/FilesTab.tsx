import type {
  AgorClient,
  Branch,
  FileDetail,
  FileListItem,
  GitFileStatusSource,
} from '@agor-live/client';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Space, Tabs } from 'antd';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { CodePreviewModal } from '../../CodePreviewModal/CodePreviewModal';
import type { FileItem } from '../../FileCollection/FileCollection';
import { FileCollection } from '../../FileCollection/FileCollection';

const MAX_FILES = 50000;

interface FilesTabProps {
  branch: Branch;
  client: AgorClient | null;
}

const FilesTabInner: React.FC<FilesTabProps> = ({ branch, client }) => {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRequestIdRef = useRef(0);

  // Modal state
  const [selectedFile, setSelectedFile] = useState<FileDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Store client and branch_id in refs to keep callbacks stable
  const clientRef = useRef(client);
  clientRef.current = client;

  const branchIdRef = useRef(branch.branch_id);
  branchIdRef.current = branch.branch_id;

  const { showLoading, showSuccess, showError } = useThemedMessage();

  // The endpoint reads the worktree and git status on every request, so the
  // same operation handles both the initial load and an in-place refresh.
  const fetchFiles = useCallback(
    async (initialLoad = false) => {
      const requestId = ++fileRequestIdRef.current;

      if (!client) {
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (initialLoad) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      setError(null);

      try {
        const data = await client.service('file').findAll({
          query: { branch_id: branch.branch_id },
        });

        if (fileRequestIdRef.current === requestId) {
          setFiles(data as FileListItem[]);
        }
      } catch (err) {
        console.error('Failed to fetch files:', err);
        if (fileRequestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (fileRequestIdRef.current === requestId) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [client, branch.branch_id]
  );

  // Fetch files when tab is opened or switches to a different branch.
  useEffect(() => {
    void fetchFiles(true);

    return () => {
      // Ignore a response from a branch that is no longer being displayed.
      fileRequestIdRef.current += 1;
    };
  }, [fetchFiles]);

  const handleRefresh = useCallback(() => {
    void fetchFiles();
  }, [fetchFiles]);

  // Download file (handles both UTF-8 text and base64 binary)
  const downloadFile = useCallback(
    async (file: FileItem) => {
      const currentClient = clientRef.current;
      if (!currentClient) return;

      if (file.gitStatus === 'deleted') {
        showError('This file was deleted in the working tree');
        return;
      }

      try {
        showLoading('Downloading file...', { key: 'download' });

        const detail = (await currentClient.service('file').get(file.path, {
          query: { branch_id: branchIdRef.current },
        })) as FileDetail;

        // Decode content based on encoding
        let blob: Blob;
        const mimeType = 'mimeType' in file ? file.mimeType : undefined;

        if (detail.encoding === 'base64') {
          // Binary file: decode base64 to binary
          const binaryString = atob(detail.content);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          blob = new Blob([bytes], {
            type: mimeType || 'application/octet-stream',
          });
        } else {
          // Text file: use UTF-8 string directly
          blob = new Blob([detail.content], {
            type: mimeType || 'text/plain',
          });
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.path.split('/').pop() || 'download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showSuccess('Downloaded!', { key: 'download' });
      } catch (err) {
        console.error('Failed to download file:', err);
        showError('Failed to download file', { key: 'download' });
      }
    },
    [showLoading, showSuccess, showError]
  );

  // Handle file click - preview text files or download others - stable callback
  const handleFileClick = useCallback(
    async (file: FileItem, gitStatusSource: GitFileStatusSource = 'combined') => {
      const currentClient = clientRef.current;
      if (!currentClient) return;

      // If text file under size limit, preview in modal
      if ('isText' in file && file.isText && file.size < 1024 * 1024) {
        try {
          setLoadingDetail(true);
          setModalOpen(true);

          // Fetch full file detail with content
          const detail = await currentClient.service('file').get(file.path, {
            query: {
              branch_id: branchIdRef.current,
              git_status_source: gitStatusSource,
            },
          });

          setSelectedFile(detail as FileDetail);
        } catch (err) {
          console.error('Failed to fetch file detail:', err);
          showError('Failed to load file');
          setModalOpen(false);
        } finally {
          setLoadingDetail(false);
        }
      } else {
        // Download file directly
        downloadFile(file);
      }
    },
    [downloadFile, showError]
  );

  const handleWorkingTreeFileClick = useCallback(
    (file: FileItem) => handleFileClick(file, 'workingTree'),
    [handleFileClick]
  );
  const handleStagedFileClick = useCallback(
    (file: FileItem) => handleFileClick(file, 'staged'),
    [handleFileClick]
  );

  // Handle modal close - stable callback
  const handleModalClose = useCallback(() => {
    setModalOpen(false);
    setSelectedFile(null);
  }, []);

  const isTruncated = files.length >= MAX_FILES;
  const visibleFiles = useMemo(
    // Deleted entries are synthesized by the executor for source-control
    // views; the regular file browser mirrors the actual worktree instead.
    () => files.filter((file) => file.gitStatus !== 'deleted'),
    [files]
  );
  const workingTreeChanges = useMemo(
    () =>
      files.filter((file) => file.gitWorkingTreeStatus && file.gitWorkingTreeStatus !== 'ignored'),
    [files]
  );
  const stagedChanges = useMemo(
    () => files.filter((file) => file.gitStagedStatus !== undefined),
    [files]
  );

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        {isTruncated && (
          <Alert
            type="warning"
            title="Woah! Big repo alert!"
            description={`Only ${MAX_FILES.toLocaleString()} files were loaded to prevent your browser from crashing. Use git/IDE for full repo browsing.`}
            showIcon
          />
        )}

        {!isTruncated && files.length > 10000 && (
          <Alert
            type="info"
            title={`Large repository: ${files.length.toLocaleString()} files loaded.`}
            description="Use search to find files quickly."
            showIcon
          />
        )}

        {error && <Alert title="Error" description={error} type="error" showIcon />}

        <Tabs
          destroyOnHidden
          tabBarStyle={{ marginInline: 24 }}
          tabBarExtraContent={
            <Button
              icon={<ReloadOutlined />}
              aria-label="Refresh files"
              loading={refreshing}
              disabled={!client || loading}
              onClick={handleRefresh}
            >
              Refresh
            </Button>
          }
          items={[
            {
              key: 'all-files',
              label: 'All files',
              children: (
                <FileCollection
                  files={visibleFiles}
                  loading={loading}
                  onFileClick={handleFileClick}
                  onDownload={downloadFile}
                  emptyMessage="No files found in branch"
                />
              ),
            },
            {
              key: 'changes',
              label: `Changes (${workingTreeChanges.length})`,
              children: (
                <FileCollection
                  files={workingTreeChanges}
                  loading={loading}
                  onFileClick={handleWorkingTreeFileClick}
                  onDownload={downloadFile}
                  emptyMessage="No unstaged changes"
                  gitStatusSource="workingTree"
                />
              ),
            },
            {
              key: 'staged-changes',
              label: `Staged changes (${stagedChanges.length})`,
              children: (
                <FileCollection
                  files={stagedChanges}
                  loading={loading}
                  onFileClick={handleStagedFileClick}
                  onDownload={downloadFile}
                  emptyMessage="No staged changes"
                  gitStatusSource="staged"
                />
              ),
            },
          ]}
        />

        <CodePreviewModal
          file={selectedFile}
          open={modalOpen}
          onClose={handleModalClose}
          loading={loadingDetail}
        />
      </Space>
    </div>
  );
};

// Memoize FilesTab to prevent re-renders when parent re-renders with same branch
export const FilesTab = memo(FilesTabInner, (prevProps, nextProps) => {
  // Re-render if branch_id changes or if client availability changes (null -> non-null or vice versa)
  // This ensures the fetch effect runs when client becomes available
  const clientAvailabilityChanged = (prevProps.client === null) !== (nextProps.client === null);
  return prevProps.branch.branch_id === nextProps.branch.branch_id && !clientAvailabilityChanged;
});
