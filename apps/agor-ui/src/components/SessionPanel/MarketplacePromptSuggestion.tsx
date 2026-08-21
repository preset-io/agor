import { Alert, Button, Space, Typography } from 'antd';
import React from 'react';
import { copyToClipboard } from '../../utils/clipboard';

export interface MarketplacePromptSuggestionProps {
  prompt: string;
  onInsert: () => void;
  onDismiss: () => void;
  isCurrent?: () => boolean;
  style?: React.CSSProperties;
}

/**
 * A starter prompt is a suggestion, not a draft mutation. It reaches the
 * composer only from the explicit Insert action; Copy and Dismiss never touch
 * composer state.
 */
export function MarketplacePromptSuggestion({
  prompt,
  onInsert,
  onDismiss,
  isCurrent = () => true,
  style,
}: MarketplacePromptSuggestionProps) {
  const [copyStatus, setCopyStatus] = React.useState('');
  const handleCopy = React.useCallback(async () => {
    if (!isCurrent()) return;
    const copied = await copyToClipboard(prompt);
    if (!isCurrent()) return;
    setCopyStatus(copied ? 'Starter prompt copied' : 'Could not copy starter prompt');
  }, [isCurrent, prompt]);
  const handleInsert = React.useCallback(() => {
    if (isCurrent()) onInsert();
  }, [isCurrent, onInsert]);

  return (
    <Alert
      type="info"
      showIcon
      style={style}
      title="Starter prompt suggestion"
      description={
        <Space orientation="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Paragraph
            style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {prompt}
          </Typography.Paragraph>
          <Space size="small" wrap>
            <Button
              type="primary"
              size="small"
              aria-label="Insert starter prompt in composer"
              onClick={handleInsert}
            >
              Insert in composer
            </Button>
            <Button size="small" aria-label="Copy starter prompt" onClick={() => void handleCopy()}>
              Copy
            </Button>
            <Button size="small" aria-label="Dismiss starter prompt" onClick={onDismiss}>
              Dismiss
            </Button>
          </Space>
          {copyStatus ? (
            <Typography.Text
              role="status"
              aria-live="polite"
              aria-atomic="true"
              type={copyStatus.startsWith('Could not') ? 'danger' : 'success'}
            >
              {copyStatus}
            </Typography.Text>
          ) : null}
        </Space>
      }
    />
  );
}
