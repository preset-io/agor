/**
 * Themed Modal Utility
 *
 * Centralized modal utility with:
 * - Consistent dark mode styling via Ant Design theme tokens
 * - Type-safe API matching Ant Design's modal interface
 * - Prevents usage of unthemed Modal.confirm/info/warning/error/success
 *
 * Usage:
 * ```tsx
 * import { useThemedModal } from '@/utils/modal';
 *
 * function MyComponent() {
 *   const { confirm, info, warning, error, success } = useThemedModal();
 *
 *   const handleDelete = () => {
 *     confirm({
 *       title: 'Delete Item?',
 *       content: 'This action cannot be undone.',
 *       onOk: () => deleteItem(),
 *     });
 *   };
 * }
 * ```
 */

import { App } from 'antd';
import type { ModalFuncProps } from 'antd/es/modal/interface';

/**
 * Modal configuration options (extends ModalFuncProps)
 */
export type ThemedModalOptions = ModalFuncProps;

/**
 * Hook that provides themed modal functions
 *
 * @returns Object with modal helper functions
 */
export function useThemedModal() {
  const { modal } = App.useApp();

  /**
   * Show confirmation modal
   */
  const confirm = (options: ThemedModalOptions) => {
    return modal.confirm(options);
  };

  /**
   * Show info modal
   */
  const info = (options: ThemedModalOptions) => {
    return modal.info(options);
  };

  /**
   * Show warning modal
   */
  const warning = (options: ThemedModalOptions) => {
    return modal.warning(options);
  };

  /**
   * Show error modal
   */
  const error = (options: ThemedModalOptions) => {
    return modal.error(options);
  };

  /**
   * Show success modal
   */
  const success = (options: ThemedModalOptions) => {
    return modal.success(options);
  };

  return {
    confirm,
    info,
    warning,
    error,
    success,
  };
}

/**
 * Type re-exports for convenience
 */
export type { ModalFuncProps };
