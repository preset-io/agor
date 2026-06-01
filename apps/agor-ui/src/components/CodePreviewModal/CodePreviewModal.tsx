import type { FileDetail } from '@agor-live/client';
import { CopyOutlined } from '@ant-design/icons';
import { Button, Modal } from 'antd';
import { ThemedSyntaxHighlighter } from '@/components/ThemedSyntaxHighlighter';
import { copyToClipboard } from '@/utils/clipboard';
import { getLanguageFromPath } from '@/utils/language';
import { useThemedMessage } from '@/utils/message';

export interface CodePreviewModalProps {
  file: FileDetail | null;
  open: boolean;
  onClose: () => void;
  loading?: boolean;
}

export const CodePreviewModal = ({ file, open, onClose, loading }: CodePreviewModalProps) => {
  const { showSuccess } = useThemedMessage();

  if (!file) return null;

  const language = getLanguageFromPath(file.path);

  const handleCopyContent = async () => {
    await copyToClipboard(file.content);
    showSuccess('Content copied to clipboard!');
  };

  const handleCopyPath = async () => {
    await copyToClipboard(file.path);
    showSuccess('Path copied to clipboard!');
  };

  return (
    <Modal
      title={file.path}
      open={open}
      onCancel={onClose}
      width={900}
      styles={{
        body: {
          maxHeight: '70vh',
          overflow: 'auto',
        },
      }}
      footer={[
        <Button key="copy-path" icon={<CopyOutlined />} onClick={handleCopyPath}>
          Copy Path
        </Button>,
        <Button
          key="copy-content"
          type="primary"
          icon={<CopyOutlined />}
          onClick={handleCopyContent}
        >
          Copy Content
        </Button>,
        <Button key="close" onClick={onClose}>
          Close
        </Button>,
      ]}
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>Loading...</div>
      ) : (
        <ThemedSyntaxHighlighter language={language} showLineNumbers>
          {file.content}
        </ThemedSyntaxHighlighter>
      )}
    </Modal>
  );
};
