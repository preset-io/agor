/**
 * Themed Message Utility
 *
 * Centralized message/toast utility with:
 * - Consistent dark mode styling via Ant Design theme tokens
 * - Copy-to-clipboard functionality on all messages
 * - Type-safe API matching Ant Design's message interface
 *
 * Usage:
 * ```tsx
 * import { useThemedMessage } from '@/utils/message';
 *
 * function MyComponent() {
 *   const { showSuccess, showError, showWarning, showInfo, showLoading } = useThemedMessage();
 *
 *   const handleClick = () => {
 *     showSuccess('Operation completed!');
 *     showError('Something went wrong', { duration: 5 });
 *   };
 * }
 * ```
 */

import { CopyOutlined } from '@ant-design/icons';
import { App, Space, theme } from 'antd';
import type { ArgsProps, ConfigOptions, MessageInstance } from 'antd/es/message/interface';
import React from 'react';

/**
 * Message content wrapper with copy-to-clipboard functionality
 */
interface MessageContentProps {
  children: React.ReactNode;
  onCopy: () => void;
}

const MessageContent: React.FC<MessageContentProps> = ({ children, onCopy }) => {
  const { token } = theme.useToken();

  return (
    <Space
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      <CopyOutlined
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
        style={{
          cursor: 'pointer',
          marginLeft: token.marginSM,
          opacity: 0.65,
          transition: 'opacity 0.2s',
          fontSize: token.fontSizeSM,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '1';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = '0.65';
        }}
        title="Copy to clipboard"
      />
    </Space>
  );
};

/**
 * Extract text content from React nodes for clipboard copying
 */
function extractTextContent(content: React.ReactNode): string {
  if (typeof content === 'string') {
    return content;
  }
  if (typeof content === 'number') {
    return String(content);
  }
  if (React.isValidElement(content)) {
    // Try to extract text from React elements
    if (content.props.children) {
      return extractTextContent(content.props.children);
    }
  }
  if (Array.isArray(content)) {
    return content.map(extractTextContent).join(' ');
  }
  return String(content);
}

/**
 * Copy text to clipboard without showing additional messages
 */
async function copyToClipboardSilent(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    // Fallback for non-HTTPS environments
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    document.execCommand('copy');
    document.body.removeChild(textArea);
  } catch (error) {
    console.error('Failed to copy to clipboard:', error);
  }
}

/**
 * Message options (subset of ArgsProps with commonly used options)
 */
export interface ThemedMessageOptions {
  duration?: number;
  key?: string | number;
  onClose?: () => void;
}

/**
 * Hook that provides themed message functions with copy-to-clipboard
 *
 * @returns Object with message helper functions
 */
export function useThemedMessage() {
  const { message } = App.useApp();

  /**
   * Wrap message content with copy functionality
   */
  const wrapContent = (content: React.ReactNode, textContent: string) => {
    return (
      <MessageContent
        onCopy={() => {
          copyToClipboardSilent(textContent);
        }}
      >
        {content}
      </MessageContent>
    );
  };

  /**
   * Show success message
   */
  const showSuccess = (content: React.ReactNode, options?: ThemedMessageOptions) => {
    const textContent = extractTextContent(content);
    return message.success({
      content: wrapContent(content, textContent),
      duration: options?.duration ?? 3,
      key: options?.key,
      onClose: options?.onClose,
    });
  };

  /**
   * Show error message (longer duration by default for copying)
   */
  const showError = (content: React.ReactNode, options?: ThemedMessageOptions) => {
    const textContent = extractTextContent(content);
    return message.error({
      content: wrapContent(content, textContent),
      duration: options?.duration ?? 6, // Longer for errors so users can copy
      key: options?.key,
      onClose: options?.onClose,
    });
  };

  /**
   * Show warning message
   */
  const showWarning = (content: React.ReactNode, options?: ThemedMessageOptions) => {
    const textContent = extractTextContent(content);
    return message.warning({
      content: wrapContent(content, textContent),
      duration: options?.duration ?? 4,
      key: options?.key,
      onClose: options?.onClose,
    });
  };

  /**
   * Show info message
   */
  const showInfo = (content: React.ReactNode, options?: ThemedMessageOptions) => {
    const textContent = extractTextContent(content);
    return message.info({
      content: wrapContent(content, textContent),
      duration: options?.duration ?? 3,
      key: options?.key,
      onClose: options?.onClose,
    });
  };

  /**
   * Show loading message (no auto-dismiss, requires manual dismiss)
   */
  const showLoading = (content: React.ReactNode, options?: ThemedMessageOptions) => {
    const textContent = extractTextContent(content);
    return message.loading({
      content: wrapContent(content, textContent),
      duration: options?.duration ?? 0, // 0 means no auto-dismiss
      key: options?.key,
      onClose: options?.onClose,
    });
  };

  /**
   * Destroy a message by key
   */
  const destroy = (key?: string | number) => {
    message.destroy(key);
  };

  /**
   * Access to raw message instance for advanced usage
   */
  const raw: MessageInstance = message;

  return {
    showSuccess,
    showError,
    showWarning,
    showInfo,
    showLoading,
    destroy,
    raw,
  };
}

/**
 * Type re-exports for convenience
 */
export type { ArgsProps, ConfigOptions, MessageInstance };
