import type { AgorClient, Branch, FileDetail, FileListItem } from '@agor-live/client';
import { Alert, Space } from 'antd';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../../../config/daemon';
import { getAuthHeaders } from '../../../utils/authHeaders';
import { useThemedMessage } from '../../../utils/message';
import { CodePreviewModal } from '../../CodePreviewModal/CodePreviewModal';
import type { FileItem } from '../../FileCollection/FileCollection';
import { FileCollection } from '../../FileCollection/FileCollection';
import { MarkdownModal } from '../../MarkdownModal/MarkdownModal';

const MAX_FILES = 50000;

function branchFileDownloadUrl(branchId: string, path: string): string {
  const base = getDaemonUrl().replace(/\/$/, '');
  return `${base}/branches/${encodeURIComponent(branchId)}/files/download?path=${encodeURIComponent(path)}`;
}

/** Surface the daemon's reason (missing file, too large, denied) instead of a generic failure. */
async function describeDownloadFailure(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const detail = typeof body.message === 'string' ? body.message : body.error;
    if (typeof detail === 'string' && detail) return detail;
  } catch {
    // Non-JSON error body; fall through to the status text.
  }
  return `Download failed (HTTP ${response.status})`;
}

interface FilesTabProps {
  branch: Branch;
  client: AgorClient | null;
}

const FilesTabInner: React.FC<FilesTabProps> = ({ branch, client }) => {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Fetch files when tab is opened
  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }

    const fetchFiles = async () => {
      try {
        setLoading(true);
        setError(null);

        const data = await client.service('file').findAll({
          query: { branch_id: branch.branch_id },
        });
        setFiles(data as FileListItem[]);
      } catch (err) {
        console.error('Failed to fetch files:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchFiles();
  }, [client, branch.branch_id]);

  // Download over the streamed HTTP data plane. The `file` service inlines
  // content in its JSON result, so it is capped at the Socket.IO frame size and
  // cannot carry large files; this route streams the bytes instead.
  const downloadFile = useCallback(
    async (file: FileItem) => {
      try {
        showLoading('Downloading file...', { key: 'download' });

        const response = await fetch(branchFileDownloadUrl(branchIdRef.current, file.path), {
          headers: getAuthHeaders(),
        });
        if (!response.ok) {
          throw new Error(await describeDownloadFailure(response));
        }

        const url = URL.createObjectURL(await response.blob());
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
        showError(err instanceof Error ? err.message : 'Failed to download file', {
          key: 'download',
        });
      }
    },
    [showLoading, showSuccess, showError]
  );

  // Handle file click - preview text files or download others - stable callback
  const handleFileClick = useCallback(
    async (file: FileItem) => {
      const currentClient = clientRef.current;
      if (!currentClient) return;

      // If text file under size limit, preview in modal
      if ('isText' in file && file.isText && file.size < 1024 * 1024) {
        try {
          setLoadingDetail(true);
          setModalOpen(true);

          // Fetch full file detail with content
          const detail = await currentClient.service('file').get(file.path, {
            query: { branch_id: branchIdRef.current },
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

  // Handle modal close - stable callback
  const handleModalClose = useCallback(() => {
    setModalOpen(false);
    setSelectedFile(null);
  }, []);

  const isMarkdown = selectedFile?.path.endsWith('.md');
  const isTruncated = files.length >= MAX_FILES;

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

        <FileCollection
          files={files}
          loading={loading}
          onFileClick={handleFileClick}
          onDownload={downloadFile}
          emptyMessage="No files found in branch"
        />

        {isMarkdown ? (
          <MarkdownModal
            open={modalOpen}
            title={selectedFile?.title || ''}
            content={selectedFile?.content || ''}
            filePath={selectedFile?.path || ''}
            onClose={handleModalClose}
          />
        ) : (
          <CodePreviewModal
            file={selectedFile}
            open={modalOpen}
            onClose={handleModalClose}
            loading={loadingDetail}
          />
        )}
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
