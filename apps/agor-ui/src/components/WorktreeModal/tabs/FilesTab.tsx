import type { AgorClient } from '@agor/core/api';
import type { FileDetail, FileListItem, Worktree } from '@agor/core/types';
import { Alert, message, Space } from 'antd';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CodePreviewModal } from '../../CodePreviewModal/CodePreviewModal';
import type { FileItem } from '../../FileCollection/FileCollection';
import { FileCollection } from '../../FileCollection/FileCollection';
import { MarkdownModal } from '../../MarkdownModal/MarkdownModal';

const MAX_FILES = 50000;

interface FilesTabProps {
  worktree: Worktree;
  client: AgorClient | null;
}

const FilesTabInner: React.FC<FilesTabProps> = ({ worktree, client }) => {
  const [files, setFiles] = useState<FileListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [selectedFile, setSelectedFile] = useState<FileDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Store client and worktree_id in refs to keep callbacks stable
  const clientRef = useRef(client);
  clientRef.current = client;

  const worktreeIdRef = useRef(worktree.worktree_id);
  worktreeIdRef.current = worktree.worktree_id;

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

        const result = await client.service('file').find({
          query: { worktree_id: worktree.worktree_id },
        });
        const data = Array.isArray(result) ? result : result.data;

        setFiles(data as FileListItem[]);
      } catch (err) {
        console.error('Failed to fetch files:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchFiles();
  }, [client, worktree.worktree_id]);

  // Download file (handles both UTF-8 text and base64 binary) - stable callback
  const downloadFile = useCallback(async (file: FileItem) => {
    const currentClient = clientRef.current;
    if (!currentClient) return;

    try {
      message.loading({ content: 'Downloading file...', key: 'download' });

      const detail = (await currentClient.service('file').get(file.path, {
        query: { worktree_id: worktreeIdRef.current },
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

      message.success({ content: 'Downloaded!', key: 'download' });
    } catch (err) {
      console.error('Failed to download file:', err);
      message.error({ content: 'Failed to download file', key: 'download' });
    }
  }, []);

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
            query: { worktree_id: worktreeIdRef.current },
          });

          setSelectedFile(detail as FileDetail);
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
    },
    [downloadFile]
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
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {isTruncated && (
          <Alert
            type="warning"
            message="Woah! Big repo alert!"
            description={`Only ${MAX_FILES.toLocaleString()} files were loaded to prevent your browser from crashing. Use git/IDE for full repo browsing.`}
            showIcon
          />
        )}

        {!isTruncated && files.length > 10000 && (
          <Alert
            type="info"
            message={`Large repository: ${files.length.toLocaleString()} files loaded.`}
            description="Use search to find files quickly."
            showIcon
          />
        )}

        {error && <Alert message="Error" description={error} type="error" showIcon />}

        <FileCollection
          files={files}
          loading={loading}
          onFileClick={handleFileClick}
          onDownload={downloadFile}
          emptyMessage="No files found in worktree"
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

// Memoize FilesTab to prevent re-renders when parent re-renders with same worktree
export const FilesTab = memo(FilesTabInner, (prevProps, nextProps) => {
  // Re-render if worktree_id changes or if client availability changes (null -> non-null or vice versa)
  // This ensures the fetch effect runs when client becomes available
  const clientAvailabilityChanged = (prevProps.client === null) !== (nextProps.client === null);
  return (
    prevProps.worktree.worktree_id === nextProps.worktree.worktree_id && !clientAvailabilityChanged
  );
});
