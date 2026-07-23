import { InfoCircleOutlined } from '@ant-design/icons';
import { Input, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

const { Text } = Typography;

export interface OpenCodeModelConfig {
  provider: string;
  model: string;
}

export interface OpenCodeModelSelectorProps {
  value?: OpenCodeModelConfig;
  onChange?: (config: OpenCodeModelConfig) => void;
}

/**
 * OpenCode provider/model override.
 *
 * OpenCode discovers provider models only inside its task-scoped runtime, so
 * Agor intentionally does not call a daemon discovery service. Empty fields
 * omit the override and let OpenCode apply its configured defaults.
 */
export const OpenCodeModelSelector: React.FC<OpenCodeModelSelectorProps> = ({
  value,
  onChange,
}) => {
  const [provider, setProvider] = useState(value?.provider ?? '');
  const [model, setModel] = useState(value?.model ?? '');

  useEffect(() => {
    setProvider(value?.provider ?? '');
    setModel(value?.model ?? '');
  }, [value?.provider, value?.model]);

  const publish = (nextProvider: string, nextModel: string) => {
    if (nextProvider && nextModel) {
      onChange?.({ provider: nextProvider, model: nextModel });
      return;
    }
    // A partial pair is not executable. Publish an empty override while the
    // user finishes editing so stale provider/model values are never retained.
    onChange?.({ provider: '', model: '' });
  };

  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          Provider ID
        </Text>
        <Input
          aria-label="OpenCode provider ID"
          value={provider}
          maxLength={128}
          placeholder="Optional, e.g. openai"
          onChange={(event) => {
            const next = event.target.value.trim();
            setProvider(next);
            publish(next, model);
          }}
        />
      </div>
      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          Model ID
        </Text>
        <Input
          aria-label="OpenCode model ID"
          value={model}
          maxLength={128}
          placeholder="Optional, e.g. gpt-5"
          onChange={(event) => {
            const next = event.target.value.trim();
            setModel(next);
            publish(provider, next);
          }}
        />
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        <InfoCircleOutlined /> Enter an exact provider/model pair, or leave both empty to use
        OpenCode defaults.
      </Text>
    </Space>
  );
};
