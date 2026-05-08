import {
  type AgorClient,
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  CODEX_MODEL_METADATA,
  COPILOT_MODEL_METADATA,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  GEMINI_MODELS,
  type GeminiModel,
} from '@agor-live/client';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Input, Radio, Select, Space, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
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
  agent?: 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'copilot'; // Kept as 'agent' for backwards compat in prop name
  agentic_tool?: 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'copilot';
  /**
   * Optional Feathers client. When provided AND the agentic tool is Copilot,
   * the picker fetches the live model list from /copilot-models (which calls
   * the SDK's `listModels()` server-side) and merges it with the static
   * fallback. Without a client, the picker only shows static models.
   */
  client?: AgorClient | null;
}

interface CopilotModelOption {
  id: string;
  displayName: string;
  description?: string;
  source: 'dynamic' | 'static';
}

interface CopilotModelsResponse {
  default: string;
  models: CopilotModelOption[];
  source: 'dynamic' | 'static';
}

// Codex model options (derived from @agor/core metadata)
const CODEX_MODEL_OPTIONS = Object.entries(CODEX_MODEL_METADATA).map(([modelId, meta]) => ({
  id: modelId,
  label: meta.name,
  description: meta.description,
}));

// Gemini model options (convert from GEMINI_MODELS metadata)
const GEMINI_MODEL_OPTIONS = Object.entries(GEMINI_MODELS).map(([modelId, meta]) => ({
  id: modelId as GeminiModel,
  label: meta.name,
  description: meta.description,
}));

// Copilot model options (static fallback). The dynamic list from the SDK's
// listModels() is fetched server-side and may include BYOK-configured models
// not represented here.
const COPILOT_STATIC_MODEL_OPTIONS = Object.entries(COPILOT_MODEL_METADATA).map(
  ([modelId, meta]) => ({
    id: modelId,
    label: meta.name,
    description: meta.description,
  })
);

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
  client,
}) => {
  // Determine which model list to use based on agentic_tool (with backwards compat for agent prop)
  const effectiveTool = agentic_tool || agent || 'claude-code';

  // Copilot model list — fetched once when the picker opens for Copilot and
  // a client is available. The daemon returns either the live `listModels()`
  // result (source: 'dynamic') or the static fallback (source: 'static',
  // typically when no GitHub token is configured). Either way we render
  // whatever the server returns; the local static list is a last-resort
  // fallback for when the call itself fails.
  const [copilotServerOptions, setCopilotServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [copilotSource, setCopilotSource] = useState<'dynamic' | 'static' | null>(null);

  useEffect(() => {
    if (effectiveTool !== 'copilot' || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await client.service('copilot-models').find();
        const response = raw as unknown as CopilotModelsResponse;
        if (cancelled || !response?.models?.length) return;
        setCopilotServerOptions(
          response.models.map((m) => ({
            id: m.id,
            label: m.displayName,
            description: m.description,
          }))
        );
        setCopilotSource(response.source);
      } catch {
        // Silent fallback to local static — best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveTool, client]);

  const modelList =
    effectiveTool === 'codex'
      ? CODEX_MODEL_OPTIONS
      : effectiveTool === 'gemini'
        ? GEMINI_MODEL_OPTIONS
        : effectiveTool === 'opencode'
          ? [] // OpenCode doesn't use this list
          : effectiveTool === 'copilot'
            ? (copilotServerOptions ?? COPILOT_STATIC_MODEL_OPTIONS)
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
        defaultModel = DEFAULT_CODEX_MODEL;
      } else if (effectiveTool === 'gemini') {
        defaultModel = 'gemini-2.5-flash';
      } else if (effectiveTool === 'copilot') {
        defaultModel = DEFAULT_COPILOT_MODEL;
      } else {
        // claude-code (opencode is handled earlier in the component)
        defaultModel = 'claude-sonnet-4-6';
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
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Radio.Group value={mode} onChange={(e) => handleModeChange(e.target.value)}>
        <Space orientation="vertical">
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
              {effectiveTool === 'copilot' && copilotSource && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255, 255, 255, 0.45)' }}>
                  {copilotSource === 'dynamic' ? (
                    <>
                      Live list from your Copilot account (via SDK <code>listModels()</code>).
                    </>
                  ) : (
                    <>
                      Showing static fallback. Set <code>COPILOT_GITHUB_TOKEN</code> on the daemon
                      to see your account's live list (including BYOK models).
                    </>
                  )}
                </div>
              )}
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
                    ? `e.g., ${DEFAULT_CODEX_MODEL}`
                    : effectiveTool === 'gemini'
                      ? 'e.g., gemini-2.5-pro'
                      : effectiveTool === 'copilot'
                        ? 'e.g., gpt-4o or claude-3.5-sonnet'
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
                        : effectiveTool === 'copilot'
                          ? 'https://github.com/features/copilot'
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
