import type { DrawerProps, ModalProps } from 'antd';
import { Drawer, Modal } from 'antd';
import type React from 'react';
import { useUIMode } from '../../contexts/UIModeContext';

export interface ModalOrDrawerProps {
  open: boolean;
  title?: React.ReactNode;
  /** Maps to Modal `onCancel` in classic mode and Drawer `onClose` in slim. */
  onClose?: () => void;
  afterOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
  /** Classic-mode Modal props (width, footer, styles, …). */
  modal?: Omit<ModalProps, 'open' | 'title' | 'onCancel' | 'afterOpenChange' | 'children'>;
  /** Slim-mode Drawer props (placement, size, mask, footer, …). */
  drawer?: Omit<DrawerProps, 'open' | 'title' | 'onClose' | 'afterOpenChange' | 'children'>;
}

/**
 * Renders its content in an antd Modal (classic mode) or Drawer (slim mode).
 * Shared props cover the common surface; mode-specific presentation lives in
 * the `modal` / `drawer` prop bags.
 */
export const ModalOrDrawer: React.FC<ModalOrDrawerProps> = ({
  open,
  title,
  onClose,
  afterOpenChange,
  children,
  modal,
  drawer,
}) => {
  const { isSlim } = useUIMode();

  if (isSlim) {
    return (
      <Drawer
        open={open}
        title={title}
        onClose={onClose}
        afterOpenChange={afterOpenChange}
        {...drawer}
      >
        {children}
      </Drawer>
    );
  }

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onClose}
      afterOpenChange={afterOpenChange}
      {...modal}
    >
      {children}
    </Modal>
  );
};
