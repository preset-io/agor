import type { CredentialLintResult } from '@agor-live/client';
import { Alert, Space, Typography, theme } from 'antd';

const { Text } = Typography;

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
          message="We removed spaces or line breaks from this key — a common side effect of copying from a terminal. Check that it verifies below."
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
