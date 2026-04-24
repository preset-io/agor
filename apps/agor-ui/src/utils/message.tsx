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

import { CheckOutlined, CloseCircleOutlined, CopyOutlined } from '@ant-design/icons';
import { App, Space, theme } from 'antd';
import type { ArgsProps, ConfigOptions, MessageInstance } from 'antd/es/message/interface';
import React from 'react';
import { copyToClipboard } from './clipboard';

/**
 * Message content wrapper with copy-to-clipboard functionality.
 *
 * Shows an inline confirmation icon (check on success, X on failure) for
 * ~1.5s after click — otherwise there's no way for the user to tell whether
 * the copy worked, which reads as "the button is broken".
 */
interface MessageContentProps {
  children: React.ReactNode;
  textContent: string;
}

const MessageContent: React.FC<MessageContentProps> = ({ children, textContent }) => {
  const { token } = theme.useToken();
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>();

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(textContent);
    setCopyState(ok ? 'copied' : 'failed');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopyState('idle'), 1500);
  };

  const iconStyle: React.CSSProperties = {
    cursor: 'pointer',
    marginLeft: token.marginSM,
    transition: 'opacity 0.2s',
    fontSize: token.fontSizeSM,
  };

  let icon: React.ReactNode;
  if (copyState === 'copied') {
    icon = (
      <CheckOutlined
        style={{ ...iconStyle, color: token.colorSuccess, opacity: 1 }}
        title="Copied!"
      />
    );
  } else if (copyState === 'failed') {
    icon = (
      <CloseCircleOutlined
        style={{ ...iconStyle, color: token.colorError, opacity: 1 }}
        title="Copy failed"
      />
    );
  } else {
    icon = (
      <CopyOutlined
        onClick={handleCopy}
        style={{ ...iconStyle, opacity: 0.65 }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '1';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = '0.65';
        }}
        title="Copy to clipboard"
      />
    );
  }

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
      {icon}
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
    return <MessageContent textContent={textContent}>{content}</MessageContent>;
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
