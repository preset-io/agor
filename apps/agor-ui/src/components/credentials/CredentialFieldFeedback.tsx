import type { CredentialFixSuggestion, CredentialLintResult } from '@agor-live/client';
import { Alert, Button, Space, Typography, theme } from 'antd';

const { Text } = Typography;

/** Label for the opt-in one-click cleanup action. */
export const CREDENTIAL_CLEAN_UP_LABEL = 'Clean it up';

export interface CredentialFieldFeedbackProps {
  /** Layer-2 lint finding for the field, if any. */
  lint?: CredentialLintResult | null;
  /**
   * Layer-1 opt-in fix suggestion (internal whitespace / wrapping quotes). We
   * NEVER apply this automatically — the user clicks the action to opt in.
   */
  fix?: CredentialFixSuggestion | null;
  /** Apply the opt-in fix (sets the field to `fix.fixedValue`). */
  onApplyFix?: () => void;
}

/**
 * Inline validation messages shared by every credential input surface: the
 * opt-in "Clean it up" fix suggestion (Layer 1) and the non-blocking format-lint
 * warning/error (Layer 2). Renders nothing when clean. The fix is only ever
 * applied when the user clicks the action — the field's value is never rewritten
 * behind their back.
 */
export const CredentialFieldFeedback: React.FC<CredentialFieldFeedbackProps> = ({
  lint,
  fix,
  onApplyFix,
}) => {
  const { token } = theme.useToken();
  if (!fix && !lint) return null;

  return (
    <Space orientation="vertical" size={token.marginXXS} style={{ width: '100%' }}>
      {fix && (
        <Alert
          type="warning"
          showIcon
          message={fix.message}
          action={
            onApplyFix ? (
              <Button size="small" type="link" onClick={onApplyFix}>
                {CREDENTIAL_CLEAN_UP_LABEL}
              </Button>
            ) : undefined
          }
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
