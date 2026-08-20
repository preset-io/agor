import type { ModalProps } from 'antd';
import { Button, Drawer, Flex, Grid, Modal } from 'antd';
import type { ReactNode } from 'react';

export type AdaptiveSettingsModalProps = Omit<ModalProps, 'footer'> & {
  footer?: ReactNode;
};

/** Desktop dialog that becomes a bottom sheet on phone-sized settings surfaces. */
export function AdaptiveSettingsModal({
  children,
  title,
  open,
  onCancel,
  onOk,
  okText = 'OK',
  cancelText = 'Cancel',
  okButtonProps,
  cancelButtonProps,
  confirmLoading,
  footer,
  afterClose,
  destroyOnHidden,
  width,
  closable,
  maskClosable,
  keyboard,
  ...modalProps
}: AdaptiveSettingsModalProps) {
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;

  if (!compact) {
    return (
      <Modal
        {...modalProps}
        title={title}
        open={open}
        onCancel={onCancel}
        onOk={onOk}
        okText={okText}
        cancelText={cancelText}
        okButtonProps={okButtonProps}
        cancelButtonProps={cancelButtonProps}
        confirmLoading={confirmLoading}
        footer={footer}
        afterClose={afterClose}
        destroyOnHidden={destroyOnHidden}
        width={width}
        closable={closable}
        maskClosable={maskClosable}
        keyboard={keyboard}
      >
        {children}
      </Modal>
    );
  }

  const resolvedFooter =
    footer === null ? null : footer !== undefined ? (
      footer
    ) : (
      <Flex justify="flex-end" gap={8} wrap>
        <Button {...cancelButtonProps} onClick={onCancel}>
          {cancelText}
        </Button>
        <Button type="primary" {...okButtonProps} loading={confirmLoading} onClick={onOk}>
          {okText}
        </Button>
      </Flex>
    );

  return (
    <Drawer
      title={title}
      open={open}
      onClose={onCancel}
      placement="bottom"
      size="large"
      closable={closable}
      maskClosable={maskClosable}
      keyboard={keyboard}
      destroyOnHidden={destroyOnHidden}
      afterOpenChange={(isOpen) => {
        if (!isOpen) afterClose?.();
      }}
      styles={{
        container: { borderStartStartRadius: 16, borderStartEndRadius: 16, overflow: 'hidden' },
        body: { overflowX: 'hidden', overflowY: 'auto', padding: 16 },
        footer: { padding: '12px 16px' },
      }}
      footer={resolvedFooter}
    >
      {children}
    </Drawer>
  );
}
