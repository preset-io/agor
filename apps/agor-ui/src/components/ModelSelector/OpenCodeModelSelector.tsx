import { createClient } from '@agor/core/api';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Select, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';

const { Text } = Typography;

export interface OpenCodeModelConfig {
  provider: string; // providerID (e.g., 'openai', 'opencode')
  model: string; // modelID (e.g., 'gpt-4o', 'claude-sonnet-4-5')
}

export interface OpenCodeModelSelectorProps {
  value?: OpenCodeModelConfig;
  onChange?: (config: OpenCodeModelConfig) => void;
}

interface Provider {
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

interface ProvidersResponse {
  providers: Provider[];
  default?: string;
}

/**
 * OpenCode Model Selector - Dynamic 2-dropdown UI
 *
 * Fetches available providers and models from OpenCode API
 * Shows Provider dropdown → Model dropdown based on selected provider
 */
export const OpenCodeModelSelector: React.FC<OpenCodeModelSelectorProps> = ({
  value,
  onChange,
}) => {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasSetDefault, setHasSetDefault] = useState(false);

  // Fetch providers/models from daemon endpoint
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only fetch once on mount
  useEffect(() => {
    const fetchProviders = async () => {
      try {
        setLoading(true);
        setError(null);

        // Create client to fetch OpenCode models
        const daemonUrl = getDaemonUrl();
        const client = createClient(daemonUrl);

        const response = (await client
          .service('opencode/models')
          .find()) as unknown as ProvidersResponse;

        setProviders(response.providers || []);
      } catch (err) {
        console.error('Failed to fetch OpenCode models:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to fetch models. Is OpenCode server running?'
        );
      } finally {
        setLoading(false);
      }
    };

    fetchProviders();
  }, []); // Only fetch once on mount

  // Set default value only if no value is provided and we haven't set a default yet
  // This runs after providers are loaded and when value changes
  useEffect(() => {
    if (!value && providers.length > 0 && !hasSetDefault && onChange) {
      const defaultProvider = providers[0];
      const defaultModel = defaultProvider.models?.[0];

      if (defaultProvider && defaultModel) {
        onChange({
          provider: defaultProvider.id,
          model: defaultModel.id,
        });
        setHasSetDefault(true);
      }
    }
  }, [value, providers, hasSetDefault, onChange]);

  const selectedProvider = providers.find((p) => p.id === value?.provider);
  const availableModels = selectedProvider?.models || [];

  const handleProviderChange = (newProvider: string) => {
    const provider = providers.find((p) => p.id === newProvider);
    if (provider && provider.models.length > 0 && onChange) {
      // When provider changes, select first model
      onChange({
        provider: newProvider,
        model: provider.models[0].id,
      });
    }
  };

  const handleModelChange = (newModel: string) => {
    if (onChange && value?.provider) {
      onChange({
        provider: value.provider,
        model: newModel,
      });
    }
  };

  if (loading) {
    return (
      <Space>
        <Spin size="small" />
        <Text type="secondary">Loading OpenCode models...</Text>
      </Space>
    );
  }

  if (error) {
    return (
      <Alert
        message="OpenCode Unavailable"
        description={error}
        type="warning"
        showIcon
        icon={<InfoCircleOutlined />}
        action={
          <Text type="secondary" style={{ fontSize: 12 }}>
            Start OpenCode server: <code>opencode serve --port 4096</code>
          </Text>
        }
      />
    );
  }

  if (providers.length === 0) {
    return (
      <Alert
        message="No Providers Available"
        description="OpenCode server returned no providers. Check your OpenCode installation."
        type="info"
        showIcon
      />
    );
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {/* Provider Dropdown */}
      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          Provider
        </Text>
        <Select
          style={{ width: '100%' }}
          value={value?.provider}
          onChange={handleProviderChange}
          placeholder="Select provider"
        >
          {providers.map((provider) => (
            <Select.Option key={provider.id} value={provider.id}>
              <Space>
                <span>{provider.name}</span>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ({provider.models.length} models)
                </Text>
              </Space>
            </Select.Option>
          ))}
        </Select>
      </div>

      {/* Model Dropdown (filtered by selected provider) */}
      {selectedProvider && (
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Model
          </Text>
          <Select
            style={{ width: '100%' }}
            value={value?.model}
            onChange={handleModelChange}
            placeholder="Select model"
            showSearch
            optionFilterProp="children"
          >
            {availableModels.map((model) => (
              <Select.Option key={model.id} value={model.id}>
                {model.name}
              </Select.Option>
            ))}
          </Select>
        </div>
      )}

      {/* Info message */}
      <Text type="secondary" style={{ fontSize: 12 }}>
        <InfoCircleOutlined /> Models available based on your OpenCode configuration
      </Text>
    </Space>
  );
};
