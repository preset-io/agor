import { Button, Flex, Input, type InputProps, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';

interface GatewayNameInputProps
  extends Pick<InputProps, 'id' | 'aria-describedby' | 'aria-invalid' | 'aria-required'> {
  targetName?: string;
  channelTypeLabel: string;
  value?: string;
  /** Programmatic suggestions must not trigger user-edit validation. */
  onSuggest: (value: string) => void;
  onChange?: (value: string) => void;
}

/** Creation-only control. The named Form.Item remounts it on resetFields(),
 * resetting customization along with the draft rather than inferring it from text. */
export function GatewayNameInput({
  targetName,
  channelTypeLabel,
  value,
  onSuggest,
  onChange,
  ...accessibilityProps
}: GatewayNameInputProps) {
  const { token } = theme.useToken();
  const [editing, setEditing] = useState(false);
  const [customized, setCustomized] = useState(false);
  const suggestedName = targetName ? `${targetName} · ${channelTypeLabel}` : '';

  useEffect(() => {
    if (!customized && value !== suggestedName) onSuggest(suggestedName);
  }, [customized, onSuggest, suggestedName, value]);

  if (editing) {
    return (
      <Input
        {...accessibilityProps}
        aria-label="Channel name"
        aria-required
        value={value}
        autoFocus
        onChange={(event) => {
          setCustomized(true);
          onChange?.(event.target.value);
        }}
      />
    );
  }

  return (
    <Flex
      {...accessibilityProps}
      role="group"
      aria-label="Channel name"
      align="center"
      gap={token.marginXS}
      style={{ minWidth: 0 }}
    >
      <Typography.Text type="secondary" ellipsis={{ tooltip: value }} style={{ minWidth: 0 }}>
        {value}
      </Typography.Text>
      <Button
        type="text"
        size="small"
        aria-label="Rename gateway"
        onClick={() => setEditing(true)}
        style={{ flexShrink: 0 }}
      >
        Rename
      </Button>
    </Flex>
  );
}
