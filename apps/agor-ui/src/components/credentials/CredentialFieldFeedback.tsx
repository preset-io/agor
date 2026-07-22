import type { CredentialLintResult } from '@agor-live/client';
import { Alert, Space, Typography, theme } from 'antd';

const { Text } = Typography;

/**
 * Canonical copy for the Layer-1 internal-fix notice. Covers internal-whitespace
 * collapse AND wrapping-quote strips (both flagged as `internalWhitespaceFixed`).
 * Exported so any surface that can't render the component reuses the same words.
 */
export const CREDENTIAL_INTERNAL_FIX_NOTICE =
  'We removed spaces, line breaks, or wrapping quotes from this key — a common side effect of copying from a terminal. Check that it verifies below.';

export interface CredentialFieldFeedbackProps {
  /** Layer-2 lint finding for the field, if any. */
  lint?: CredentialLintResult | null;
  /** Whether the dismissible "we repaired internal whitespace" notice is showing. */
  internalFixVisible?: boolean;
  /** Dismiss the internal-fix notice. */
  onDismissInternalFix?: () => void;
}

/**
 * Inline validation messages shared by every credential input surface: the
 * dismissible "we removed spaces/line breaks" notice (Layer 1) and the
 * non-blocking format-lint warning/error (Layer 2). Renders nothing when clean.
 */
export const CredentialFieldFeedback: React.FC<CredentialFieldFeedbackProps> = ({
  lint,
  internalFixVisible,
  onDismissInternalFix,
}) => {
  const { token } = theme.useToken();
  if (!internalFixVisible && !lint) return null;

  return (
    <Space orientation="vertical" size={token.marginXXS} style={{ width: '100%' }}>
      {internalFixVisible && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={onDismissInternalFix}
          message={CREDENTIAL_INTERNAL_FIX_NOTICE}
          style={{ fontSize: token.fontSizeSM }}
        />
      )}
      {lint && (
        <Text
          type={lint.severity === 'error' ? 'danger' : 'warning'}
          style={{ fontSize: token.fontSizeSM }}
        >
          {lint.message}
        </Text>
      )}
    </Space>
  );
};
