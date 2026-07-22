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
import { AutoComplete, Button, Flex, Select, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { AdvisorModelSelect } from './AdvisorModelSelect';
import {
  curateModelOptions,
  DEFAULT_CURSOR_MODEL,
  ensureDefaultModelOption,
  getModelDisplayName,
  getModelSelectorFallbackModel,
  normalizeModelOption,
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
  /**
   * Render the Claude Code advisor model select inline. Surfaces that relocate
   * the advisor into an "Advanced" area (e.g. NewSessionModal) pass `false`.
   */
  showAdvisor?: boolean;
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

const PIN_PLACEHOLDERS: Record<string, string> = {
  codex: `e.g., ${DEFAULT_CODEX_MODEL}`,
  gemini: 'e.g., gemini-2.5-pro',
  copilot: 'e.g., gpt-4o or claude-3.5-sonnet',
  cursor: `e.g., ${DEFAULT_CURSOR_MODEL}`,
};

/**
 * Model Selector Component
 *
 * Presents a curated, richly-labelled list of model aliases (latest per family)
 * and a "Pin a specific version…" affordance for exact model IDs. Picking from
 * the list maps to `mode: 'alias'`; a pinned/custom ID maps to `mode: 'exact'`.
 */
export const ModelSelector: React.FC<ModelSelectorProps> = ({
  value,
  onChange,
  agent,
  agentic_tool,
  client,
  compact = false,
  showAdvisor = true,
}) => {
  const { token } = theme.useToken();

  // Determine which model list to use based on agentic_tool (with backwards compat for agent prop)
  const effectiveTool = agentic_tool || agent || 'claude-code';
  const isClaude = effectiveTool === 'claude-code' || effectiveTool === 'claude-code-cli';

  // Dynamic model lists — fetched once when the picker opens for a given tool
  // and a client is available.
  const [claudeServerOptions, setClaudeServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [copilotServerOptions, setCopilotServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [cursorServerOptions, setCursorServerOptions] = useState<Array<{
    id: string;
    label: string;
    description?: string;
  }> | null>(null);
  const [copilotDefaultModel, setCopilotDefaultModel] = useState(DEFAULT_COPILOT_MODEL);
  const [cursorDefaultModel, setCursorDefaultModel] = useState(DEFAULT_CURSOR_MODEL);

  useEffect(() => {
    if (!isClaude || !client) return;
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
      } catch {
        // Silent fallback to local static — best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isClaude, client]);

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
      } catch {
        // Silent fallback to local static — best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveTool, client]);

  const rawModelList =
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

  // Pin mode reflects the stored config: an exact ID is an explicitly-pinned
  // version, anything else is a curated alias selection.
  const [pinned, setPinned] = useState(value?.mode === 'exact');
  useEffect(() => {
    setPinned(value?.mode === 'exact');
  }, [value?.mode]);

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

  const fallbackModel = getModelSelectorFallbackModel(effectiveTool, rawModelList, {
    copilotDefaultModel,
    cursorDefaultModel,
  });

  const normalizedList = rawModelList.map(normalizeModelOption);
  const curated = curateModelOptions(effectiveTool, normalizedList, fallbackModel);
  const currentModel = value?.model || fallbackModel;

  const selectAlias = (model: string) => {
    onChange?.({ ...value, mode: 'alias', model });
  };
  const selectPinned = (model: string) => {
    onChange?.({ ...value, mode: 'exact', model });
  };
  const handleAdvisorModelChange = (advisorModel: string | undefined) => {
    onChange?.({
      ...value,
      mode: value?.mode ?? 'alias',
      model: currentModel,
      advisorModel,
    });
  };

  const enablePin = () => {
    setPinned(true);
  };
  const disablePin = () => {
    setPinned(false);
    selectAlias(curated.some((m) => m.id === currentModel) ? currentModel : fallbackModel);
  };

  // Alias options: curated list, with the currently-selected alias preserved
  // even if curation would otherwise hide it (e.g. a superseded version).
  const aliasOptions = curated.map((m) => ({
    value: m.id,
    label: m.displayName,
    description: m.description,
    isDefault: m.id === fallbackModel,
    searchText: `${m.displayName} ${m.id} ${m.description ?? ''}`.toLowerCase(),
  }));
  if (!pinned && currentModel && !aliasOptions.some((o) => o.value === currentModel)) {
    const norm = normalizedList.find((m) => m.id === currentModel);
    aliasOptions.unshift({
      value: currentModel,
      label: norm?.displayName ?? getModelDisplayName(effectiveTool, currentModel),
      description: norm?.description,
      isDefault: false,
      searchText: currentModel.toLowerCase(),
    });
  }

  const renderAliasOption = (optionValue: string) => {
    const data = aliasOptions.find((o) => o.value === optionValue);
    return (
      <Flex justify="space-between" align="start" gap={12} style={{ minWidth: 300 }}>
        {/* whiteSpace:normal + flex:1/minWidth:0 lets descriptions wrap to
            multiple lines instead of antd's default option ellipsis. */}
        <div style={{ lineHeight: 1.3, whiteSpace: 'normal', flex: 1, minWidth: 0 }}>
          <div>{data?.label ?? optionValue}</div>
          {data?.description && (
            <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'normal' }}>
              {data.description}
            </Typography.Text>
          )}
        </div>
        {data?.isDefault && (
          <Tag bordered={false} color="blue" style={{ marginInlineEnd: 0, fontSize: 10 }}>
            default
          </Tag>
        )}
      </Flex>
    );
  };

  // Compact: single dropdown for toolbars/popovers. Rich rows, displayName label.
  if (compact) {
    const compactOptions = aliasOptions.map((o) => ({
      value: o.value,
      label: o.label,
      searchText: o.searchText,
    }));
    // Compact has no pin toggle, so an exact/pinned current value would be
    // absent from the curated list — always surface the current selection.
    if (currentModel && !compactOptions.some((o) => o.value === currentModel)) {
      const norm = normalizedList.find((m) => m.id === currentModel);
      compactOptions.unshift({
        value: currentModel,
        label: norm?.displayName ?? getModelDisplayName(effectiveTool, currentModel),
        searchText: currentModel.toLowerCase(),
      });
    }
    const modelSelect = (
      <Select
        value={currentModel}
        onChange={selectAlias}
        size="small"
        showSearch
        filterOption={(input, option) => (option?.searchText ?? '').includes(input.toLowerCase())}
        optionLabelProp="label"
        popupMatchSelectWidth={false}
        style={{ width: '100%', fontSize: token.fontSizeSM }}
        options={compactOptions}
        optionRender={(option) => renderAliasOption(String(option.value))}
      />
    );

    if (!isClaude || !showAdvisor) return modelSelect;

    return (
      <Space orientation="vertical" size={6} style={{ width: '100%' }}>
        {modelSelect}
        <AdvisorModelSelect
          value={value?.advisorModel}
          onChange={handleAdvisorModelChange}
          options={claudeServerOptions ?? undefined}
          client={client}
          size="small"
          style={{ fontSize: token.fontSizeSM }}
        />
      </Space>
    );
  }

  const pinOptions = normalizedList.map((m) => ({ value: m.id, label: m.displayName }));

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={8}>
      {!pinned ? (
        <Select
          showSearch
          value={currentModel}
          onChange={selectAlias}
          optionLabelProp="label"
          filterOption={(input, option) => (option?.searchText ?? '').includes(input.toLowerCase())}
          style={{ width: '100%' }}
          options={aliasOptions}
          optionRender={(option) => renderAliasOption(String(option.value))}
        />
      ) : (
        <AutoComplete
          value={currentModel}
          onChange={selectPinned}
          options={pinOptions}
          filterOption={(input, option) =>
            `${option?.value ?? ''} ${option?.label ?? ''}`
              .toLowerCase()
              .includes(input.toLowerCase())
          }
          placeholder={PIN_PLACEHOLDERS[effectiveTool] ?? 'e.g., claude-opus-4-8-20251115'}
          style={{ width: '100%' }}
        />
      )}

      {!pinned ? (
        <Button
          type="link"
          size="small"
          onClick={enablePin}
          style={{ height: 'auto', padding: 0, fontSize: token.fontSizeSM }}
        >
          Pin a specific version…
        </Button>
      ) : (
        <Button
          type="link"
          size="small"
          onClick={disablePin}
          style={{ height: 'auto', padding: 0, fontSize: token.fontSizeSM }}
        >
          Use a recommended model
        </Button>
      )}

      {isClaude && showAdvisor && (
        <div>
          <Space size={4}>
            <span>Advisor model</span>
            <Tooltip title="Optional Claude Code advisor-tool model. Leave off to use existing Claude settings.">
              <InfoCircleOutlined />
            </Tooltip>
          </Space>
          <AdvisorModelSelect
            value={value?.advisorModel}
            onChange={handleAdvisorModelChange}
            options={claudeServerOptions ?? undefined}
            client={client}
            style={{ marginTop: 8 }}
          />
        </div>
      )}
    </Space>
  );
};
