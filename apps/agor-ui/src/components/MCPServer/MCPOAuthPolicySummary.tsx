import type { MCPServer } from '@agor/core/types';
import { Typography } from 'antd';

/** Read-only server/attempt evidence, intentionally independent of form values. */
export function MCPOAuthPolicySummary({
  policy,
  label,
}: {
  policy: Omit<NonNullable<MCPServer['oauth_compatibility_policy']>, 'managed_by_catalog'>;
  label: 'Saved OAuth policy' | 'Policy at failure';
}) {
  return (
    <Typography.Paragraph type="secondary">
      {label}: compatibility <Typography.Text code>{policy.effective_mode}</Typography.Text>
      {policy.effective_dcr_mode && (
        <>
          {'; '}DCR <Typography.Text code>{policy.effective_dcr_mode}</Typography.Text>
          {policy.dcr_mode_source && ` (${policy.dcr_mode_source})`}
        </>
      )}
      .
    </Typography.Paragraph>
  );
}
