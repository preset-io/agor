import {
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  GEMINI_MODELS,
  type GeminiModel,
} from '@agor/core/tools/models';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Input, Radio, Select, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { type OpenCodeModelConfig, OpenCodeModelSelector } from './OpenCodeModelSelector';

const { Link } = Typography;

export interface ModelConfig {
  mode: 'alias' | 'exact';
  model: string;
  // OpenCode-specific: provider + model
  provider?: string;
}

export interface ModelSelectorProps {
  value?: ModelConfig;
  onChange?: (config: ModelConfig) => void;
  agent?: 'claude-code' | 'codex' | 'gemini' | 'opencode'; // Kept as 'agent' for backwards compat in prop name
  agentic_tool?: 'claude-code' | 'codex' | 'gemini' | 'opencode';
}

// Codex model options
const CODEX_MODEL_OPTIONS = [
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex (Default)',
    description: 'Optimized for software engineering',
  },
  { id: 'codex-mini-latest', label: 'Codex Mini', description: 'Faster, lighter model' },
  { id: 'gpt-4o', label: 'GPT-4o', description: 'General purpose model' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini', description: 'Smaller, faster model' },
];

// Gemini model options (convert from GEMINI_MODELS metadata)
const GEMINI_MODEL_OPTIONS = Object.entries(GEMINI_MODELS).map(([modelId, meta]) => ({
  id: modelId as GeminiModel,
  label: meta.name,
  description: meta.description,
}));

/**
 * Model Selector Component
 *
 * Allows users to choose between:
 * - Model aliases (e.g., 'claude-sonnet-4-5-latest') - automatically uses latest version
 * - Exact model IDs (e.g., 'claude-sonnet-4-5-20250929') - pins to specific release
 *
 * Shows agent-specific models based on the agent prop.
 */
export const ModelSelector: React.FC<ModelSelectorProps> = ({
  value,
  onChange,
  agent,
  agentic_tool,
}) => {
  // Determine which model list to use based on agentic_tool (with backwards compat for agent prop)
  const effectiveTool = agentic_tool || agent || 'claude-code';

  // OpenCode uses a different UI (2 dropdowns: provider + model)
  if (effectiveTool === 'opencode') {
    return (
      <OpenCodeModelSelector
        value={
          value?.provider || value?.model
            ? {
                provider: value.provider || '',
                model: value.model || '',
              }
            : undefined
        }
        onChange={(openCodeConfig: OpenCodeModelConfig) => {
          if (onChange) {
            onChange({
              mode: 'exact', // OpenCode always uses exact provider+model IDs
              model: openCodeConfig.model,
              provider: openCodeConfig.provider,
            });
          }
        }}
      />
    );
  }

  const modelList =
    effectiveTool === 'codex'
      ? CODEX_MODEL_OPTIONS
      : effectiveTool === 'gemini'
        ? GEMINI_MODEL_OPTIONS
        : AVAILABLE_CLAUDE_MODEL_ALIASES;

  // Determine initial mode based on whether the value is in the aliases list
  // If no value provided, default to 'alias' mode (recommended)
  const isValueInAliases = value?.model ? modelList.some((m) => m.id === value.model) : true; // Default to true when no value (will use alias mode)

  const initialMode = value?.mode || (isValueInAliases ? 'alias' : 'exact');
  const [mode, setMode] = useState<'alias' | 'exact'>(initialMode);

  const handleModeChange = (newMode: 'alias' | 'exact') => {
    setMode(newMode);
    if (onChange) {
      // When switching modes, provide a default model
      let defaultModel: string;
      if (newMode === 'alias') {
        defaultModel = modelList[0].id;
      } else if (effectiveTool === 'codex') {
        defaultModel = 'gpt-5-codex';
      } else if (effectiveTool === 'gemini') {
        defaultModel = 'gemini-2.5-flash';
      } else {
        // claude-code (opencode is handled earlier in the component)
        defaultModel = 'claude-sonnet-4-5-20250929';
      }
      onChange({
        mode: newMode,
        model: value?.model || defaultModel,
      });
    }
  };

  const handleModelChange = (newModel: string) => {
    if (onChange) {
      onChange({
        mode,
        model: newModel,
      });
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Radio.Group value={mode} onChange={(e) => handleModeChange(e.target.value)}>
        <Space direction="vertical">
          <Radio value="alias">
            <Space>
              Use model alias (recommended)
              <Tooltip title="Automatically uses the latest version of the model">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          </Radio>

          {mode === 'alias' && (
            <div style={{ marginLeft: 24, marginTop: 8 }}>
              <Select
                value={value?.model || modelList[0].id}
                onChange={handleModelChange}
                style={{ width: '100%', minWidth: 400 }}
                options={modelList.map((m) => ({
                  value: m.id,
                  label: m.id,
                }))}
              />
            </div>
          )}

          <Radio value="exact">
            <Space>
              Specify exact model ID
              <Tooltip title="Pin to a specific model release for reproducibility">
                <InfoCircleOutlined />
              </Tooltip>
            </Space>
          </Radio>

          {mode === 'exact' && (
            <div style={{ marginLeft: 24, marginTop: 8 }}>
              <Input
                value={value?.model}
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder={
                  effectiveTool === 'codex'
                    ? 'e.g., gpt-5-codex'
                    : effectiveTool === 'gemini'
                      ? 'e.g., gemini-2.5-pro'
                      : 'e.g., claude-opus-4-20250514' // claude-code (opencode handled earlier)
                }
                style={{ width: '100%', minWidth: 400 }}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255, 255, 255, 0.45)' }}>
                Enter any model ID to pin to a specific version.{' '}
                <Link
                  href={
                    effectiveTool === 'codex'
                      ? 'https://platform.openai.com/docs/models'
                      : effectiveTool === 'gemini'
                        ? 'https://ai.google.dev/gemini-api/docs/models'
                        : 'https://docs.anthropic.com/en/docs/about-claude/models' // claude-code (opencode handled earlier)
                  }
                  target="_blank"
                  style={{ fontSize: 12 }}
                >
                  View available models
                </Link>
              </div>
            </div>
          )}
        </Space>
      </Radio.Group>
    </Space>
  );
};
