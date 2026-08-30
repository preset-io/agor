import type { FileDetail } from '@agor-live/client';
import { CopyOutlined } from '@ant-design/icons';
import { Button, Empty, Modal, Segmented, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { ThemedSyntaxHighlighter } from '@/components/ThemedSyntaxHighlighter';
import { copyToClipboard } from '@/utils/clipboard';
import { getLanguageFromPath } from '@/utils/language';
import { useThemedMessage } from '@/utils/message';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { DiffBlock } from '../ToolUseRenderer/renderers/DiffBlock';

export interface CodePreviewModalProps {
  file: FileDetail | null;
  open: boolean;
  onClose: () => void;
  loading?: boolean;
}

export const CodePreviewModal = ({ file, open, onClose, loading }: CodePreviewModalProps) => {
  const { showSuccess } = useThemedMessage();
  const [mode, setMode] = useState<'file' | 'changes'>('file');

  useEffect(() => {
    if (open && file) {
      setMode(file.gitStatus === 'deleted' ? 'changes' : 'file');
    }
  }, [file, open]);

  if (!file) return null;

  const language = getLanguageFromPath(file.path);
  const hasDiff = file.gitDiff !== undefined;
  const isMarkdown = file.path.toLowerCase().endsWith('.md');
  const operationType =
    file.gitStatus === 'deleted'
      ? 'delete'
      : file.gitStatus === 'added' || file.gitStatus === 'untracked'
        ? 'create'
        : 'edit';

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
        <Spin style={{ display: 'block', padding: '2rem' }} description="Loading file…" />
      ) : (
        <>
          {hasDiff && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <Segmented<'file' | 'changes'>
                aria-label="File preview mode"
                value={mode}
                onChange={setMode}
                options={[
                  { label: 'File', value: 'file', disabled: file.gitStatus === 'deleted' },
                  { label: 'Changes', value: 'changes' },
                ]}
              />
            </div>
          )}

          {hasDiff && mode === 'changes' ? (
            file.gitDiff?.baseContent === file.content ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No content changes" />
            ) : (
              <DiffBlock
                filePath={file.path}
                operationType={operationType}
                oldContent={file.gitDiff?.baseContent}
                newContent={file.content}
                forceExpanded
              />
            )
          ) : isMarkdown ? (
            <MarkdownRenderer content={file.content} />
          ) : (
            <ThemedSyntaxHighlighter language={language} showLineNumbers>
              {file.content}
            </ThemedSyntaxHighlighter>
          )}
        </>
      )}
    </Modal>
  );
};
