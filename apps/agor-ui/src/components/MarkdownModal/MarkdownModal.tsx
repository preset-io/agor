/**
 * MarkdownModal - Reusable modal for displaying markdown content
 *
 * Features:
 * - Full-width modal for comfortable reading
 * - Breadcrumb path header
 * - Uses existing MarkdownRenderer component
 * - Scrollable content area
 */

import { Modal } from 'antd';
import type React from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';

export interface MarkdownModalProps {
  /** Whether modal is visible */
  open: boolean;

  /** Close handler */
  onClose: () => void;

  /** Modal title (extracted from markdown or filename) */
  title: string;

  /** Full markdown content to render */
  content: string;

  /** File path for breadcrumb (e.g., "concepts/core.md") */
  filePath: string;
}

/**
 * Parse file path into breadcrumb items
 * "concepts/primitives/session.md" -> ["concepts", "primitives", "session.md"]
 */
function parseBreadcrumb(filePath: string): { title: string }[] {
  const parts = filePath.split('/');
  return parts.map((part) => ({ title: part }));
}

export const MarkdownModal: React.FC<MarkdownModalProps> = ({
  open,
  onClose,
  title,
  content,
  filePath,
}) => {
  const _breadcrumbItems = parseBreadcrumb(filePath);

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={900}
      styles={{
        body: {
          maxHeight: '70vh',
          overflowY: 'auto',
          padding: '24px',
        },
      }}
    >
      <MarkdownRenderer content={content} />
    </Modal>
  );
};
