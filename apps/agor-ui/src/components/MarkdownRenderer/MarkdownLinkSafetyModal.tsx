import { ExportOutlined } from '@ant-design/icons';
import { Modal, Typography } from 'antd';
import type React from 'react';
import type { LinkSafetyModalProps } from 'streamdown';

/**
 * Ant Design implementation of Streamdown's link-safety confirmation.
 *
 * Streamdown 2.x intercepts markdown link clicks by default and renders a
 * Tailwind/shadcn-styled confirmation dialog. Agor supplies this AntD Modal
 * through the supported `linkSafety.renderModal` hook so the dialog follows
 * the active theme (light/dark/custom) and AntD's modal stacking/z-index.
 */
export const MarkdownLinkSafetyModal: React.FC<LinkSafetyModalProps> = ({
  url,
  isOpen,
  onClose,
  onConfirm,
}) => (
  <Modal
    open={isOpen}
    onCancel={onClose}
    onOk={onConfirm}
    okText="Open link"
    okButtonProps={{ icon: <ExportOutlined /> }}
    cancelText="Close"
    title="Open external link?"
    width={480}
  >
    <Typography.Paragraph type="secondary">
      You're about to visit an external website.
    </Typography.Paragraph>
    <Typography.Text code copyable={{ tooltips: ['Copy link', 'Copied'] }}>
      {url}
    </Typography.Text>
  </Modal>
);
