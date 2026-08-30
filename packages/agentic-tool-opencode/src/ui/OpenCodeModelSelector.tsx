import type { AgorClient } from '@agor/core/client';
import type { EffortLevel, OpenCodeModelCatalog } from '@agor/core/types';
import {
  InfoCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Alert, Button, Flex, Input, Popover, Select, Space, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOpenCodeModelCatalog } from './useOpenCodeModelCatalog';
import { useOpenCodeReasoningEffortLevels } from './useOpenCodeReasoningEffortLevels';

const { Text } = Typography;

type StoredCatalogState = 'unknown' | 'available' | 'unavailable' | 'unlisted';

export interface OpenCodeModelConfig {
  provider: string;
  model: string;
}

export interface OpenCodeModelSelectorProps {
  value?: OpenCodeModelConfig;
  onChange?: (config: OpenCodeModelConfig | undefined) => void;
  /** Fired for an explicit catalog or exact-ID selection, never an automatic suggestion. */
  onCommit?: (config: OpenCodeModelConfig) => void;
  onReasoningEffortLevelsChange?: (availability: {
    provider: string;
    model: string;
    levels: readonly EffortLevel[] | undefined;
  }) => void;
  client?: AgorClient | null;
  branchId?: string;
  /**
   * False for a collaborative session owned by somebody else. Its immutable
   * owner executes the task, so the caller's catalog would be misleading.
   */
  catalogEnabled?: boolean;
  /** Single bounded control for footer/popover surfaces. */
  compact?: boolean;
  /** Keep nested Ant Design overlays inside a parent-controlled popover. */
  getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
}

function compactWarning(
  catalogEnabled: boolean,
  refreshFailed: boolean,
  storedCatalogState: StoredCatalogState
): string | undefined {
  if (!catalogEnabled) {
    return 'Provider availability is private to the session owner. Their stored exact pair remains usable.';
  }
  if (refreshFailed) {
    return 'Providers and models could not be loaded. The stored selection was not changed.';
  }
  if (storedCatalogState === 'unavailable') {
    return 'The stored known provider is not currently available.';
  }
  return undefined;
}

const modelPairValue = (providerId: string, modelId: string) =>
  JSON.stringify([providerId, modelId]);

function compactModelOptions(
  catalog: OpenCodeModelCatalog | null,
  value: OpenCodeModelConfig | undefined,
  storedUnavailable: boolean,
  availabilityResolved: boolean
) {
  const groups =
    (availabilityResolved ? catalog?.providers : undefined)
      ?.filter((provider) => provider.availableForSelection && provider.models.length > 0)
      .map((provider) => ({
        label: provider.name,
        options: provider.models.map((model) => ({
          value: modelPairValue(provider.id, model.id),
          label: model.name,
          disabled: false,
          searchText:
            `${provider.name} ${provider.id} ${model.name} ${model.id} ${model.status}`.toLowerCase(),
        })),
      })) ?? [];
  const selectedValue = value ? modelPairValue(value.provider, value.model) : undefined;
  const includesStoredValue = groups.some((group) =>
    group.options.some((option) => option.value === selectedValue)
  );
  if (value && !includesStoredValue) {
    groups.splice(1, 0, {
      label: 'Stored selection',
      options: [
        {
          value: modelPairValue(value.provider, value.model),
          label: `${value.provider}/${value.model}${storedUnavailable ? ' (unavailable)' : ''}`,
          disabled: false,
          searchText:
            `${value.provider} ${value.model}${storedUnavailable ? ' unavailable' : ''}`.toLowerCase(),
        },
      ],
    });
  }
  return { groups, selectedValue };
}

interface CompactOpenCodeModelSelectorProps {
  value?: OpenCodeModelConfig;
  catalog: OpenCodeModelCatalog | null;
  catalogEnabled: boolean;
  client?: AgorClient | null;
  loading: boolean;
  availabilityResolved: boolean;
  refreshFailed: boolean;
  storedCatalogState: StoredCatalogState;
  manualFields: React.ReactNode;
  manualOpen: boolean;
  setManualOpen: (open: boolean) => void;
  refresh: () => Promise<void>;
  selectPair: (provider: string, model: string) => void;
  getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
}

function CompactOpenCodeModelSelector({
  value,
  catalog,
  catalogEnabled,
  client,
  loading,
  availabilityResolved,
  refreshFailed,
  storedCatalogState,
  manualFields,
  manualOpen,
  setManualOpen,
  refresh,
  selectPair,
  getPopupContainer,
}: CompactOpenCodeModelSelectorProps) {
  const storedUnavailable = storedCatalogState === 'unavailable';
  const { groups, selectedValue } = compactModelOptions(
    catalog,
    value,
    storedUnavailable,
    availabilityResolved
  );
  const warning = compactWarning(catalogEnabled, refreshFailed, storedCatalogState);

  return (
    <Flex align="center" gap={2} style={{ width: '100%', minWidth: 0 }}>
      <Select
        aria-label="OpenCode model"
        showSearch
        value={selectedValue}
        placeholder="Select provider/model"
        options={groups}
        optionFilterProp="searchText"
        popupMatchSelectWidth={false}
        getPopupContainer={getPopupContainer}
        listHeight={256}
        size="small"
        loading={loading}
        onChange={(next) => {
          const [nextProvider, nextModel] = JSON.parse(next) as [string, string];
          selectPair(nextProvider, nextModel);
        }}
        style={{ flex: 1, minWidth: 0 }}
      />
      {catalogEnabled && client && refreshFailed && (
        <Tooltip title="Retry loading OpenCode providers and models">
          <Button
            aria-label="Retry loading OpenCode providers and models"
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void refresh()}
          />
        </Tooltip>
      )}
      <Popover
        open={manualOpen}
        onOpenChange={setManualOpen}
        trigger="click"
        placement="topRight"
        getPopupContainer={getPopupContainer}
        title="Exact OpenCode model"
        content={<div style={{ width: 260 }}>{manualFields}</div>}
      >
        <Tooltip title="Enter exact provider and model IDs">
          <Button
            aria-label="Enter exact OpenCode IDs"
            type="text"
            size="small"
            icon={<SettingOutlined />}
          />
        </Tooltip>
      </Popover>
      {warning && (
        <Tooltip title={warning}>
          <WarningOutlined aria-label="OpenCode model warning" />
        </Tooltip>
      )}
    </Flex>
  );
}

/**
 * OpenCode model selection from a protected, server-free known-model read.
 * Manual exact entry remains usable for providers or models outside the catalog.
 */
export const OpenCodeModelSelector: React.FC<OpenCodeModelSelectorProps> = ({
  value,
  onChange,
  onCommit,
  onReasoningEffortLevelsChange,
  client,
  branchId,
  catalogEnabled = true,
  compact = false,
  getPopupContainer,
}) => {
  const [provider, setProvider] = useState(value?.provider ?? '');
  const [model, setModel] = useState(value?.model ?? '');
  const [manualOpen, setManualOpen] = useState(!catalogEnabled && !compact);
  const [compactManualOpen, setCompactManualOpen] = useState(false);
  const appliedSuggestionRef = useRef<string | null>(null);
  const { catalog, availabilityResolved, loading, refreshFailed, refresh } =
    useOpenCodeModelCatalog({ client, catalogEnabled });
  const {
    levels: selectedReasoningEffortLevels,
    resolve: resolveReasoningEffortLevels,
    liveLoading,
    liveFailed,
    retry: retryLiveDiscovery,
  } = useOpenCodeReasoningEffortLevels({
    client,
    branchId,
    catalogEnabled,
    provider,
    model,
  });
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), retryLiveDiscovery()]);
  }, [refresh, retryLiveDiscovery]);
  const discoveryLoading = loading || liveLoading;
  const discoveryFailed = refreshFailed || liveFailed;

  useEffect(() => {
    setProvider(value?.provider ?? '');
    setModel(value?.model ?? '');
  }, [value?.provider, value?.model]);

  useEffect(() => {
    if (!catalogEnabled) setManualOpen(!compact);
  }, [catalogEnabled, compact]);

  const storedCatalogState = useMemo<StoredCatalogState>(() => {
    if (!value || !catalog) return 'unknown';
    const storedProvider = catalog.providers.find((entry) => entry.id === value.provider);
    if (!storedProvider?.models.some((candidate) => candidate.id === value.model)) {
      return 'unlisted';
    }
    if (!availabilityResolved) return 'unknown';
    return storedProvider.availableForSelection ? 'available' : 'unavailable';
  }, [availabilityResolved, catalog, value]);

  useEffect(() => {
    if (!provider || !model) return;
    onReasoningEffortLevelsChange?.({
      provider,
      model,
      levels: selectedReasoningEffortLevels,
    });
  }, [model, onReasoningEffortLevelsChange, provider, selectedReasoningEffortLevels]);

  useEffect(() => {
    if (
      !compact &&
      catalog &&
      (storedCatalogState === 'unavailable' || storedCatalogState === 'unlisted')
    ) {
      setManualOpen(true);
    }
  }, [catalog, compact, storedCatalogState]);

  const selectPair = (nextProvider: string, nextModel: string) => {
    const selection = { provider: nextProvider, model: nextModel };
    const reasoningEffortLevels = resolveReasoningEffortLevels(nextProvider, nextModel);
    setProvider(nextProvider);
    setModel(nextModel);
    setManualOpen(false);
    setCompactManualOpen(false);
    onChange?.(selection);
    onReasoningEffortLevelsChange?.({
      ...selection,
      levels: reasoningEffortLevels,
    });
    onCommit?.(selection);
  };

  useEffect(() => {
    if (value || !availabilityResolved || !catalog?.suggestedSelection) return;
    const { providerId, modelId } = catalog.suggestedSelection;
    const suggestionKey = `${branchId ?? ''}\0${providerId}\0${modelId}`;
    if (appliedSuggestionRef.current === suggestionKey) return;
    appliedSuggestionRef.current = suggestionKey;
    setProvider(providerId);
    setModel(modelId);
    setManualOpen(false);
    setCompactManualOpen(false);
    onChange?.({ provider: providerId, model: modelId });
  }, [availabilityResolved, branchId, catalog?.suggestedSelection, onChange, value]);

  const selectedCatalogProvider = catalog?.providers.find((entry) => entry.id === provider);
  const providerOptions =
    (availabilityResolved ? catalog?.providers : undefined)
      ?.filter((entry) => entry.availableForSelection)
      .map((entry) => ({
        value: entry.id,
        label: entry.name,
        searchText: `${entry.name} ${entry.id}`.toLowerCase(),
      })) ?? [];
  const modelOptions =
    availabilityResolved && selectedCatalogProvider?.availableForSelection
      ? selectedCatalogProvider.models.map((candidate) => ({
          value: candidate.id,
          label:
            candidate.status === 'active'
              ? candidate.name
              : `${candidate.name} · ${candidate.status}`,
          searchText:
            `${candidate.name} ${candidate.id} ${candidate.status} ${selectedCatalogProvider.name} ${selectedCatalogProvider.id}`.toLowerCase(),
        }))
      : [];

  const manualFields = (
    <Space orientation="vertical" style={{ width: '100%' }} size={8}>
      <div>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          Provider ID
        </Text>
        <Input
          aria-label="OpenCode provider ID"
          value={provider}
          maxLength={128}
          placeholder="e.g. openai"
          onChange={(event) => setProvider(event.target.value.trim())}
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
          placeholder="e.g. gpt-5"
          onChange={(event) => setModel(event.target.value.trim())}
        />
      </div>
      <Button
        type="primary"
        disabled={!provider || !model}
        onClick={() => selectPair(provider, model)}
      >
        Use exact IDs
      </Button>
      <Text type="secondary" style={{ fontSize: 12 }}>
        <InfoCircleOutlined /> Manual entry is an exact fallback. Availability is enforced on the
        same task runtime before a session or prompt is created.
      </Text>
    </Space>
  );

  if (compact) {
    return (
      <CompactOpenCodeModelSelector
        value={value}
        catalog={catalog}
        catalogEnabled={catalogEnabled}
        client={client}
        loading={discoveryLoading}
        availabilityResolved={availabilityResolved}
        refreshFailed={discoveryFailed}
        storedCatalogState={storedCatalogState}
        manualFields={manualFields}
        manualOpen={compactManualOpen}
        setManualOpen={setCompactManualOpen}
        refresh={refreshAll}
        selectPair={selectPair}
        getPopupContainer={getPopupContainer}
      />
    );
  }

  return (
    <Space orientation="vertical" size={10} style={{ width: '100%' }}>
      {!catalogEnabled && (
        <Alert
          type="info"
          showIcon
          title="Provider availability is private to the session owner"
          description="Execution uses the immutable session owner's OpenCode credentials. Their availability is not shown to collaborators; keep the stored exact pair or enter exact IDs manually."
        />
      )}

      {discoveryFailed && (
        <Alert
          type="warning"
          showIcon
          title="Could not load configured OpenCode providers"
          description="The stored selection was not changed. Retry or enter an exact provider/model pair manually."
          action={
            <Button size="small" loading={discoveryLoading} onClick={() => void refreshAll()}>
              Retry
            </Button>
          }
        />
      )}

      {catalog && (
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Select
            aria-label="OpenCode provider"
            showSearch
            value={
              availabilityResolved && selectedCatalogProvider?.availableForSelection
                ? provider
                : undefined
            }
            placeholder="Select a provider"
            options={providerOptions}
            optionFilterProp="searchText"
            getPopupContainer={getPopupContainer}
            onChange={(nextProvider) => {
              setProvider(nextProvider);
              setModel('');
              setManualOpen(
                catalog.providers.find((entry) => entry.id === nextProvider)?.models.length === 0
              );
            }}
            style={{ width: '100%' }}
          />
          <Select
            aria-label="OpenCode model"
            showSearch
            disabled={
              !availabilityResolved ||
              !selectedCatalogProvider?.availableForSelection ||
              modelOptions.length === 0
            }
            value={
              availabilityResolved && selectedCatalogProvider?.availableForSelection && model
                ? model
                : undefined
            }
            placeholder={
              availabilityResolved &&
              selectedCatalogProvider?.availableForSelection &&
              modelOptions.length === 0
                ? 'Enter an exact model ID below'
                : selectedCatalogProvider
                  ? 'Select a model'
                  : 'Select a provider first'
            }
            options={modelOptions}
            optionFilterProp="searchText"
            getPopupContainer={getPopupContainer}
            listHeight={320}
            onChange={(nextModel) => selectPair(provider, nextModel)}
            style={{ width: '100%' }}
          />
        </Space>
      )}

      {value && catalog && storedCatalogState === 'unavailable' && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          title={`${value.provider}/${value.model} is not currently available`}
          description="The stored pair is preserved. Connect the provider, choose an available model, or edit the exact IDs below."
        />
      )}

      {value && catalog && storedCatalogState === 'unlisted' && (
        <Alert
          type="info"
          showIcon
          title={`${value.provider}/${value.model} is outside the known catalog`}
          description="The exact pair is preserved and will be validated by the task runtime. Edit the IDs below if needed."
        />
      )}

      {!manualOpen && (
        <Button type="link" icon={<SettingOutlined />} onClick={() => setManualOpen(true)}>
          Enter exact IDs manually
        </Button>
      )}

      {(manualOpen || !catalogEnabled) && manualFields}
    </Space>
  );
};
