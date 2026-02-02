import { AVAILABLE_CLAUDE_MODEL_ALIASES, GEMINI_MODELS, type GeminiModel } from '@agor/core/models';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Input, Radio, Select, Space, Tooltip } from 'antd';
import { useState } from 'react';
import { type OpenCodeModelConfig, OpenCodeModelSelector } from './OpenCodeModelSelector';

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
  // GPT-5.2 models (latest, recommended)
  {
    id: 'gpt-5.2',
    label: 'GPT-5.2 (Recommended)',
    description: 'Best for complex tasks - 400k context, thinking mode',
  },
  {
    id: 'gpt-5.2-pro',
    label: 'GPT-5.2 Pro',
    description: 'Highest accuracy, xhigh reasoning for difficult problems',
  },
  {
    id: 'gpt-5.2-instant',
    label: 'GPT-5.2 Instant',
    description: 'Faster model for writing and information seeking',
  },
  // GPT-5.1 models
  {
    id: 'gpt-5.1-codex-max',
    label: 'GPT-5.1 Codex Max',
    description: 'Optimized for long-horizon agentic coding',
  },
  {
    id: 'gpt-5.1-codex',
    label: 'GPT-5.1 Codex',
    description: 'Optimized for agentic coding tasks',
  },
  {
    id: 'gpt-5.1-codex-mini',
    label: 'GPT-5.1 Codex Mini',
    description: 'Cost-effective variant with 4x more usage',
  },
  // GPT-5 models (legacy)
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    description: 'Legacy model for software engineering',
  },
  {
    id: 'gpt-5-codex-mini',
    label: 'GPT-5 Codex Mini',
    description: 'Legacy faster, lighter model',
  },
  // GPT-4o models
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

  // Calculate model list (needed for initial mode calculation)
  const modelList =
    effectiveTool === 'codex'
      ? CODEX_MODEL_OPTIONS
      : effectiveTool === 'gemini'
        ? GEMINI_MODEL_OPTIONS
        : effectiveTool === 'opencode'
          ? [] // OpenCode doesn't use this list
          : AVAILABLE_CLAUDE_MODEL_ALIASES;

  // Determine initial mode based on whether the value is in the aliases list
  // If no value provided, default to 'alias' mode (recommended)
  const isValueInAliases = value?.model ? modelList.some((m) => m.id === value.model) : true; // Default to true when no value (will use alias mode)
  const initialMode = value?.mode || (isValueInAliases ? 'alias' : 'exact');

  // IMPORTANT: Call hooks unconditionally before any early returns (React rules of hooks)
  const [mode, setMode] = useState<'alias' | 'exact'>(initialMode);

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

  const handleModeChange = (newMode: 'alias' | 'exact') => {
    setMode(newMode);
    if (onChange) {
      // When switching modes, provide a default model
      let defaultModel: string;
      if (newMode === 'alias') {
        defaultModel = modelList[0].id;
      } else if (effectiveTool === 'codex') {
        defaultModel = 'gpt-5.2';
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
                    ? 'e.g., gpt-5.2'
                    : effectiveTool === 'gemini'
                      ? 'e.g., gemini-2.5-pro'
                      : 'e.g., claude-opus-4-20250514' // claude-code (opencode handled earlier)
                }
                style={{ width: '100%', minWidth: 400 }}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255, 255, 255, 0.45)' }}>
                Enter any model ID to pin to a specific version.{' '}
                <a
                  href={
                    effectiveTool === 'codex'
                      ? 'https://platform.openai.com/docs/models'
                      : effectiveTool === 'gemini'
                        ? 'https://ai.google.dev/gemini-api/docs/models'
                        : 'https://platform.claude.com/docs/en/about-claude/models' // claude-code (opencode handled earlier)
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: 12, color: '#1677ff' }}
                >
                  View available models
                </a>
              </div>
            </div>
          )}
        </Space>
      </Radio.Group>
    </Space>
  );
};
