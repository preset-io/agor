import type { FileDetail } from '@agor-live/client';
import { CopyOutlined } from '@ant-design/icons';
import { Button, Modal } from 'antd';
import { ThemedSyntaxHighlighter } from '@/components/ThemedSyntaxHighlighter';
import { copyToClipboard } from '@/utils/clipboard';
import { useThemedMessage } from '@/utils/message';

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
