import {
  type AgorClient,
  AVAILABLE_CLAUDE_MODEL_ALIASES,
  CODEX_MODEL_METADATA,
  COPILOT_MODEL_METADATA,
  CURSOR_MODEL_METADATA,
  DEFAULT_CODEX_MODEL,
  DEFAULT_COPILOT_MODEL,
  GEMINI_MODELS,
  type GeminiModel,
} from '@agor-live/client';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Input, Radio, Select, Space, Tooltip, theme } from 'antd';
import { useEffect, useState } from 'react';
import {
  DEFAULT_CURSOR_MODEL,
  ensureDefaultModelOption,
  getModelSelectorFallbackModel,
} from './modelDefaults';
import { type OpenCodeModelConfig, OpenCodeModelSelector } from './OpenCodeModelSelector';

export interface ModelConfig {
  mode: 'alias' | 'exact';
  model: string;
  // Claude Code-specific: server-side advisor tool model.
  advisorModel?: string;
  // OpenCode-specific: provider + model
  provider?: string;
}

export interface ModelSelectorProps {
  value?: ModelConfig;
  onChange?: (config: ModelConfig) => void;
  agent?:
    | 'claude-code'
    | 'claude-code-cli'
    | 'codex'
    | 'gemini'
    | 'opencode'
    | 'copilot'
    | 'cursor'; // Kept as 'agent' for backwards compat in prop name
  agentic_tool?:
    | 'claude-code'
    | 'claude-code-cli'
    | 'codex'
    | 'gemini'
    | 'opencode'
    | 'copilot'
    | 'cursor';
  /**
   * Optional Feathers client. When provided AND the agentic tool supports
   * dynamic model discovery (Copilot/Cursor), the picker fetches the live
   * model list server-side and merges it with the static fallback. Without a
   * client, the picker only shows static models.
   */
  client?: AgorClient | null;
  /** Render as a single compact dropdown suitable for popovers/toolbars. */
  compact?: boolean;
}

interface DynamicModelOption {
  id: string;
  displayName: string;
  description?: string;
  source: 'dynamic' | 'static';
}

interface DynamicModelsResponse {
  default: string;
  models: DynamicModelOption[];
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

const CURSOR_MODEL_OPTIONS = [
  {
    id: DEFAULT_CURSOR_MODEL,
    label: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].displayName,
    description: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].description,
  },
];

function preferDefaultModel<T extends { id: string }>(models: T[], defaultModel: string): T[] {
  const defaultIndex = models.findIndex((model) => model.id === defaultModel);
  if (defaultIndex <= 0) return models;
  return [
    models[defaultIndex],
    ...models.slice(0, defaultIndex),
    ...models.slice(defaultIndex + 1),
  ];
}

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
  compact = false,
}) => {
  const { token } = theme.useToken();

  // Determine which model list to use based on agentic_tool (with backwards compat for agent prop)
  const effectiveTool = agentic_tool || agent || 'claude-code';

  // Dynamic model lists — fetched once when the picker opens for a given tool
  // and a client is available. The daemon returns either the live SDK result
  // (source: 'dynamic') or the static fallback (source: 'static'). The local
  // static list is a last-resort fallback for when the call itself fails.
  const [claudeServerOptions, setClaudeServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [claudeSource, setClaudeSource] = useState<'dynamic' | 'static' | null>(null);
  const [copilotServerOptions, setCopilotServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [copilotSource, setCopilotSource] = useState<'dynamic' | 'static' | null>(null);
  const [cursorServerOptions, setCursorServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [cursorSource, setCursorSource] = useState<'dynamic' | 'static' | null>(null);
  const [copilotDefaultModel, setCopilotDefaultModel] = useState(DEFAULT_COPILOT_MODEL);
  const [cursorDefaultModel, setCursorDefaultModel] = useState(DEFAULT_CURSOR_MODEL);

  useEffect(() => {
    if ((effectiveTool !== 'claude-code' && effectiveTool !== 'claude-code-cli') || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await client.service('claude-models').find();
        const response = raw as unknown as DynamicModelsResponse;
        if (cancelled || !response?.models?.length) return;
        const models = response.models.map((m) => ({
          id: m.id,
          label: m.displayName,
          description: m.description,
        }));
        setClaudeServerOptions(models);
        setClaudeSource(response.source);
      } catch {
        // Silent fallback to local static — best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveTool, client]);

  useEffect(() => {
    if (effectiveTool !== 'copilot' || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await client.service('copilot-models').find();
        const response = raw as unknown as DynamicModelsResponse;
        if (cancelled || !response?.models?.length) return;
        const defaultModel = response.default || DEFAULT_COPILOT_MODEL;
        const models = response.models.map((m) => ({
          id: m.id,
          label: m.displayName,
          description: m.description,
        }));
        setCopilotServerOptions(
          preferDefaultModel(
            ensureDefaultModelOption(models, defaultModel, (id) => ({
              id,
              label: id,
              description: 'Default model',
            })),
            defaultModel
          )
        );
        setCopilotDefaultModel(defaultModel);
        setCopilotSource(response.source);
      } catch {
        // Silent fallback to local static — best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveTool, client]);

  useEffect(() => {
    if (effectiveTool !== 'cursor' || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await client.service('cursor-models').find();
        const response = raw as unknown as DynamicModelsResponse;
        if (cancelled || !response?.models?.length) return;
        const defaultModel = response.default || DEFAULT_CURSOR_MODEL;
        const models = response.models.map((m) => ({
          id: m.id,
          label: m.displayName,
          description: m.description,
        }));
        setCursorServerOptions(
          preferDefaultModel(
            ensureDefaultModelOption(models, defaultModel, (id) => ({
              id,
              label: id,
              description: 'Default model',
            })),
            defaultModel
          )
        );
        setCursorDefaultModel(defaultModel);
        setCursorSource(response.source);
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
            : effectiveTool === 'cursor'
              ? preferDefaultModel(cursorServerOptions ?? CURSOR_MODEL_OPTIONS, cursorDefaultModel)
              : (claudeServerOptions ?? AVAILABLE_CLAUDE_MODEL_ALIASES);

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

  const fallbackModel = getModelSelectorFallbackModel(effectiveTool, modelList, {
    copilotDefaultModel,
    cursorDefaultModel,
  });

  const handleModeChange = (newMode: 'alias' | 'exact') => {
    setMode(newMode);
    if (onChange) {
      // When switching modes, provide the same effective default the daemon
      // applies if the form is submitted without a model_config.
      onChange({
        ...value,
        mode: newMode,
        model: value?.model || fallbackModel,
      });
    }
  };

  const handleModelChange = (newModel: string) => {
    if (onChange) {
      onChange({
        ...value,
        mode,
        model: newModel,
      });
    }
  };

  const handleAdvisorModelChange = (advisorModel: string | undefined) => {
    if (onChange) {
      onChange({
        ...value,
        mode,
        model: value?.model || fallbackModel,
        advisorModel,
      });
    }
  };

  if (compact) {
    const currentValue = value?.model || fallbackModel;
    const options = modelList.map((m) => ({
      value: m.id,
      label: m.id,
    }));
    if (currentValue && !options.some((option) => option.value === currentValue)) {
      options.unshift({ value: currentValue, label: currentValue });
    }

    const modelSelect = (
      <Select
        value={currentValue}
        onChange={handleModelChange}
        size="small"
        showSearch
        optionFilterProp="label"
        popupMatchSelectWidth={false}
        style={{ width: '100%', fontSize: token.fontSizeSM }}
        options={options}
      />
    );

    // Surface the optional Claude Code advisor model in compact contexts too
    // (e.g. the session run-settings popover) so it can be set OR cleared per
    // session. `allowClear` → undefined removes the session-level override.
    const showAdvisor = effectiveTool === 'claude-code' || effectiveTool === 'claude-code-cli';
    if (!showAdvisor) return modelSelect;

    return (
      <Space orientation="vertical" size={6} style={{ width: '100%' }}>
        {modelSelect}
        <Select
          allowClear
          showSearch
          size="small"
          optionFilterProp="label"
          placeholder="Advisor model: off"
          value={value?.advisorModel}
          onChange={handleAdvisorModelChange}
          popupMatchSelectWidth={false}
          style={{ width: '100%', fontSize: token.fontSizeSM }}
          options={(claudeServerOptions ?? AVAILABLE_CLAUDE_MODEL_ALIASES).map((model) => ({
            value: model.id,
            label: `Advisor: ${model.id}`,
          }))}
        />
      </Space>
    );
  }

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
                showSearch
                optionFilterProp="label"
                value={value?.model || fallbackModel}
                onChange={handleModelChange}
                style={{ width: '100%', minWidth: 400 }}
                options={modelList.map((m) => ({
                  value: m.id,
                  label: m.id,
                }))}
              />
              {(effectiveTool === 'claude-code' || effectiveTool === 'claude-code-cli') &&
                claudeSource && (
                  <div style={{ marginTop: 6, fontSize: 12, color: token.colorTextTertiary }}>
                    {claudeSource === 'dynamic' ? (
                      <>Live list from the Anthropic Models API.</>
                    ) : (
                      <>
                        Showing static fallback. Set <code>ANTHROPIC_API_KEY</code> to see the live
                        model list.
                      </>
                    )}
                  </div>
                )}
              {effectiveTool === 'copilot' && copilotSource && (
                <div style={{ marginTop: 6, fontSize: 12, color: token.colorTextTertiary }}>
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
              {effectiveTool === 'cursor' && cursorSource && (
                <div style={{ marginTop: 6, fontSize: 12, color: token.colorTextTertiary }}>
                  {cursorSource === 'dynamic' ? (
                    <>
                      Live list from your Cursor account (via SDK <code>Cursor.models.list()</code>
                      ).
                    </>
                  ) : (
                    <>
                      Showing static fallback. Set <code>CURSOR_API_KEY</code> to see your account's
                      live Cursor model list.
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
                        : effectiveTool === 'cursor'
                          ? `e.g., ${DEFAULT_CURSOR_MODEL}`
                          : 'e.g., claude-opus-4-20250514' // claude-code (opencode handled earlier)
                }
                style={{ width: '100%', minWidth: 400 }}
              />
              <div style={{ marginTop: 8, fontSize: 12, color: token.colorTextTertiary }}>
                Enter any model ID to pin to a specific version.{' '}
                <a
                  href={
                    effectiveTool === 'codex'
                      ? 'https://platform.openai.com/docs/models'
                      : effectiveTool === 'gemini'
                        ? 'https://ai.google.dev/gemini-api/docs/models'
                        : effectiveTool === 'copilot'
                          ? 'https://github.com/features/copilot'
                          : effectiveTool === 'cursor'
                            ? 'https://cursor.com/docs/api/sdk/typescript'
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

      {(effectiveTool === 'claude-code' || effectiveTool === 'claude-code-cli') && (
        <div>
          <Space size={4}>
            <span>Advisor model</span>
            <Tooltip title="Optional Claude Code advisor tool model. Leave unset to use existing Claude settings or disable session-level override.">
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="Not set"
            value={value?.advisorModel}
            onChange={handleAdvisorModelChange}
            style={{ width: '100%', minWidth: 400, marginTop: 8 }}
            options={(claudeServerOptions ?? AVAILABLE_CLAUDE_MODEL_ALIASES).map((model) => ({
              value: model.id,
              label: model.id,
            }))}
          />
        </div>
      )}
    </Space>
  );
};
