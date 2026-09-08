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

import {
  CheckOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CopyOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { App, Button, Space, theme } from 'antd';
import type { ArgsProps, ConfigOptions, MessageInstance } from 'antd/es/message/interface';
import React, { useCallback, useMemo } from 'react';
import { copyToClipboard } from './clipboard';

const VISUALLY_HIDDEN_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

let nextErrorMessageKey = 0;

function createErrorMessageKey(): string {
  nextErrorMessageKey += 1;
  return `agor-error-message-${nextErrorMessageKey}`;
}

/**
 * Message content wrapper with copy-to-clipboard functionality.
 *
 * Shows an inline confirmation icon (check on success, X on failure) for
 * ~1.5s after click — otherwise there's no way for the user to tell whether
 * the copy worked, which reads as "the button is broken".
 *
 * When `onTroubleshoot` is supplied (error toasts raised via
 * `useTroubleshootError().showErrorWithTroubleshoot`), a small "Troubleshoot"
 * button is rendered next to the copy icon that hands the error off to an
 * agent session. Plain toasts never pass it, so they look unchanged.
 */
export interface MessageContentProps {
  children: React.ReactNode;
  textContent: string;
  kind?: 'error' | 'message';
  onDismiss?: () => void;
  returnFocusTo?: HTMLElement | null;
  /**
   * Optional handler that spins up an agent session seeded with this error.
   * May be async — the button shows a loading spinner until it settles. The
   * handler owns its own success/failure feedback.
   */
  onTroubleshoot?: () => Promise<void> | void;
  troubleshootLabel?: string;
}

export const MessageContent: React.FC<MessageContentProps> = ({
  children,
  textContent,
  kind = 'message',
  onDismiss,
  returnFocusTo,
  onTroubleshoot,
  troubleshootLabel = 'Troubleshoot',
}) => {
  const { token } = theme.useToken();
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [troubleshooting, setTroubleshooting] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The toast auto-dismisses (~6s) and clicking Troubleshoot navigates away,
  // so this node can unmount mid-flight; guard the post-await setState.
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const ok = await copyToClipboard(textContent);
    setCopyState(ok ? 'copied' : 'failed');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopyState('idle'), 1500);
  };

  const handleTroubleshoot = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onTroubleshoot || troubleshooting) return;
    try {
      setTroubleshooting(true);
      await onTroubleshoot();
    } finally {
      if (mountedRef.current) setTroubleshooting(false);
    }
  };

  const handleDismiss = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();

    // Dismissing a focused alert should not strand focus on document.body.
    // Prefer an adjacent persistent error, then return to the control that was
    // focused when this error appeared. Errors resolved by a keyed update do
    // not move focus.
    const dismissButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-agor-error-dismiss]')
    );
    const currentIndex = dismissButtons.indexOf(e.currentTarget);
    const nextFocusTarget =
      dismissButtons[currentIndex + 1] ?? dismissButtons[currentIndex - 1] ?? returnFocusTo;

    onDismiss?.();
    queueMicrotask(() => {
      if (nextFocusTarget?.isConnected) {
        nextFocusTarget.focus({ preventScroll: true });
      }
    });
  };

  let copyIcon: React.ReactNode;
  let copyAccessibleLabel: string;
  let statusText = '';
  if (copyState === 'copied') {
    copyIcon = <CheckOutlined />;
    copyAccessibleLabel = kind === 'error' ? 'Copied error message' : 'Copied message';
    statusText =
      kind === 'error' ? 'Error message copied to clipboard.' : 'Message copied to clipboard.';
  } else if (copyState === 'failed') {
    copyIcon = <CloseCircleOutlined />;
    copyAccessibleLabel =
      kind === 'error' ? 'Copy failed for error message' : 'Copy failed for message';
    statusText = `Could not copy ${kind} message.`;
  } else {
    copyIcon = <CopyOutlined />;
    copyAccessibleLabel = kind === 'error' ? 'Copy error message' : 'Copy message';
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
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
      <Space size="small">
        {onTroubleshoot && (
          <Button
            type="link"
            size="small"
            icon={<ThunderboltOutlined />}
            loading={troubleshooting}
            onClick={handleTroubleshoot}
            style={{ paddingInline: token.paddingXXS, fontSize: token.fontSizeSM }}
            title="Hand this error to an agent to troubleshoot"
          >
            {troubleshootLabel}
          </Button>
        )}
        <Button
          type="text"
          size="small"
          icon={copyIcon}
          aria-label={copyAccessibleLabel}
          title={copyAccessibleLabel}
          onClick={handleCopy}
        />
        {onDismiss && (
          <Button
            type="text"
            size="small"
            icon={<CloseOutlined />}
            aria-label="Dismiss error message"
            title="Dismiss error message"
            data-agor-error-dismiss
            onClick={handleDismiss}
          />
        )}
      </Space>
      <output aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN_STYLE}>
        {statusText}
      </output>
    </Space>
  );
};

/**
 * Extract text content from React nodes for clipboard copying
 */
export function extractTextContent(content: React.ReactNode): string {
  if (typeof content === 'string') {
    return content;
  }
  if (typeof content === 'number') {
    return String(content);
  }
  if (typeof content === 'bigint') {
    return String(content);
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(content)) {
    // Try to extract text from React elements
    if (content.props.children !== undefined && content.props.children !== null) {
      return extractTextContent(content.props.children);
    }
  }
  if (Array.isArray(content)) {
    return content.map(extractTextContent).join(' ');
  }
  return '';
}

function extractVisibleTextContent(content: React.ReactNode): string {
  return extractTextContent(content).replace(/\s+/g, ' ').trim();
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
 * Hook that provides themed message functions with copy-to-clipboard.
 *
 * The returned helpers are stable across renders (memoized with `useCallback`
 * over antd's stable `App.useApp().message` instance), so they're safe to put
 * in `useCallback`/`useEffect` dep arrays without churn.
 */
export function useThemedMessage() {
  const { message } = App.useApp();

  const showSuccess = useCallback(
    (content: React.ReactNode, options?: ThemedMessageOptions) =>
      message.success({
        content: (
          <MessageContent textContent={extractVisibleTextContent(content)}>
            {content}
          </MessageContent>
        ),
        duration: options?.duration ?? 3,
        key: options?.key,
        onClose: options?.onClose,
      }),
    [message]
  );

  // Errors persist until the user dismisses them or a keyed update replaces
  // them. Callers can still opt into a finite duration explicitly.
  const showError = useCallback(
    (content: React.ReactNode, options?: ThemedMessageOptions) => {
      const key = options?.key ?? createErrorMessageKey();
      const returnFocusTo =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      let closed = false;
      const handleClose = () => {
        if (closed) return;
        closed = true;
        options?.onClose?.();
      };
      const handleDismiss = () => {
        handleClose();
        message.destroy(key);
      };

      return message.error({
        content: (
          <MessageContent
            textContent={extractVisibleTextContent(content)}
            kind="error"
            onDismiss={handleDismiss}
            returnFocusTo={returnFocusTo}
          >
            {content}
          </MessageContent>
        ),
        duration: options?.duration ?? 0,
        key,
        onClose: handleClose,
      });
    },
    [message]
  );

  const showWarning = useCallback(
    (content: React.ReactNode, options?: ThemedMessageOptions) =>
      message.warning({
        content: (
          <MessageContent textContent={extractVisibleTextContent(content)}>
            {content}
          </MessageContent>
        ),
        duration: options?.duration ?? 4,
        key: options?.key,
        onClose: options?.onClose,
      }),
    [message]
  );

  const showInfo = useCallback(
    (content: React.ReactNode, options?: ThemedMessageOptions) =>
      message.info({
        content: (
          <MessageContent textContent={extractVisibleTextContent(content)}>
            {content}
          </MessageContent>
        ),
        duration: options?.duration ?? 3,
        key: options?.key,
        onClose: options?.onClose,
      }),
    [message]
  );

  // Loading messages don't auto-dismiss — pair with a `key` and a follow-up
  // success/error using the same key so they replace in place.
  const showLoading = useCallback(
    (content: React.ReactNode, options?: ThemedMessageOptions) =>
      message.loading({
        content: (
          <MessageContent textContent={extractVisibleTextContent(content)}>
            {content}
          </MessageContent>
        ),
        duration: options?.duration ?? 0,
        key: options?.key,
        onClose: options?.onClose,
      }),
    [message]
  );

  const destroy = useCallback((key?: string | number) => message.destroy(key), [message]);

  return useMemo(
    () => ({ showSuccess, showError, showWarning, showInfo, showLoading, destroy }),
    [showSuccess, showError, showWarning, showInfo, showLoading, destroy]
  );
}

/**
 * Type re-exports for convenience
 */
export type { ArgsProps, ConfigOptions, MessageInstance };
