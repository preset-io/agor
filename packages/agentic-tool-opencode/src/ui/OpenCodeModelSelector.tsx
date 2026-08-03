import type { AgorClient } from '@agor/core/client';
import type { OpenCodeProviderSettings } from '@agor/core/types';
import {
  InfoCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Flex,
  Input,
  Popover,
  Select,
  Space,
  Spin,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOpenCodeConfiguration } from './useOpenCodeConfiguration';

const { Text } = Typography;

type StoredCatalogState = 'unknown' | 'available' | 'unavailable' | 'unlisted';

export interface OpenCodeModelConfig {
  provider: string;
  model: string;
}

export interface OpenCodeModelSelectorProps {
  value?: OpenCodeModelConfig;
  onChange?: (config: OpenCodeModelConfig | undefined) => void;
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
  loadFailed: boolean,
  storedCatalogState: StoredCatalogState
): string | undefined {
  if (!catalogEnabled) {
    return 'Provider availability is private to the session owner. Their stored exact pair remains usable.';
  }
  if (loadFailed) {
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
  configuration: OpenCodeProviderSettings | null,
  value: OpenCodeModelConfig | undefined,
  storedUnavailable: boolean
) {
  const groups =
    configuration?.providers.map((provider) => ({
      label: provider.runtimeAvailable ? provider.name : `${provider.name} · unavailable`,
      options: provider.models.map((model) => ({
        value: modelPairValue(provider.id, model.id),
        label: provider.runtimeAvailable ? model.name : `${model.name} · provider unavailable`,
        disabled: !provider.runtimeAvailable,
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
  configuration: OpenCodeProviderSettings | null;
  catalogEnabled: boolean;
  client?: AgorClient | null;
  loading: boolean;
  loadFailed: boolean;
  storedCatalogState: StoredCatalogState;
  manualFields: React.ReactNode;
  manualOpen: boolean;
  setManualOpen: (open: boolean) => void;
  retry: () => Promise<void>;
  selectPair: (provider: string, model: string) => void;
  getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
}

function CompactOpenCodeModelSelector({
  value,
  configuration,
  catalogEnabled,
  client,
  loading,
  loadFailed,
  storedCatalogState,
  manualFields,
  manualOpen,
  setManualOpen,
  retry,
  selectPair,
  getPopupContainer,
}: CompactOpenCodeModelSelectorProps) {
  const storedUnavailable = storedCatalogState === 'unavailable';
  const { groups, selectedValue } = compactModelOptions(configuration, value, storedUnavailable);
  const warning = compactWarning(catalogEnabled, loadFailed, storedCatalogState);

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
      {catalogEnabled && client && loadFailed && (
        <Tooltip title="Retry loading OpenCode providers and models">
          <Button
            aria-label="Retry loading OpenCode providers and models"
            type="text"
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void retry()}
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
 * OpenCode model selection from a protected runtime configuration snapshot.
 * Manual exact entry remains usable for providers or models outside discovery.
 */
export const OpenCodeModelSelector: React.FC<OpenCodeModelSelectorProps> = ({
  value,
  onChange,
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
  const { configuration, loading, loadFailed, retry } = useOpenCodeConfiguration({
    client,
    branchId,
    enabled: catalogEnabled,
  });

  useEffect(() => {
    setProvider(value?.provider ?? '');
    setModel(value?.model ?? '');
  }, [value?.provider, value?.model]);

  useEffect(() => {
    if (!catalogEnabled) setManualOpen(!compact);
  }, [catalogEnabled, compact]);

  const storedCatalogState = useMemo<StoredCatalogState>(() => {
    if (!value || !configuration) return 'unknown';
    const storedProvider = configuration.providers.find((entry) => entry.id === value.provider);
    if (!storedProvider?.models.some((candidate) => candidate.id === value.model)) {
      return 'unlisted';
    }
    return storedProvider.runtimeAvailable ? 'available' : 'unavailable';
  }, [configuration, value]);

  useEffect(() => {
    if (
      !compact &&
      configuration &&
      (storedCatalogState === 'unavailable' || storedCatalogState === 'unlisted')
    ) {
      setManualOpen(true);
    }
  }, [configuration, compact, storedCatalogState]);

  const selectPair = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModel(nextModel);
    setManualOpen(false);
    setCompactManualOpen(false);
    onChange?.({ provider: nextProvider, model: nextModel });
  };

  useEffect(() => {
    if (value || !configuration?.suggestedSelection) return;
    const { providerId, modelId } = configuration.suggestedSelection;
    const suggestionKey = `${branchId ?? ''}\0${providerId}\0${modelId}`;
    if (appliedSuggestionRef.current === suggestionKey) return;
    appliedSuggestionRef.current = suggestionKey;
    setProvider(providerId);
    setModel(modelId);
    setManualOpen(false);
    setCompactManualOpen(false);
    onChange?.({ provider: providerId, model: modelId });
  }, [branchId, configuration?.suggestedSelection, onChange, value]);

  const selectedCatalogProvider = configuration?.providers.find((entry) => entry.id === provider);
  const providerOptions =
    configuration?.providers.map((entry) => ({
      value: entry.id,
      label: entry.runtimeAvailable ? entry.name : `${entry.name} · unavailable`,
      disabled: !entry.runtimeAvailable,
      searchText:
        `${entry.name} ${entry.id}${entry.runtimeAvailable ? '' : ' unavailable'}`.toLowerCase(),
    })) ?? [];
  const modelOptions =
    selectedCatalogProvider?.models.map((candidate) => ({
      value: candidate.id,
      label:
        candidate.status === 'active' ? candidate.name : `${candidate.name} · ${candidate.status}`,
      searchText:
        `${candidate.name} ${candidate.id} ${candidate.status} ${selectedCatalogProvider.name} ${selectedCatalogProvider.id}`.toLowerCase(),
    })) ?? [];

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
        configuration={configuration}
        catalogEnabled={catalogEnabled}
        client={client}
        loading={loading}
        loadFailed={loadFailed}
        storedCatalogState={storedCatalogState}
        manualFields={manualFields}
        manualOpen={compactManualOpen}
        setManualOpen={setCompactManualOpen}
        retry={retry}
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

      {loadFailed && (
        <Alert
          type="warning"
          showIcon
          title="Could not load OpenCode providers and models"
          description="The stored selection was not changed. Retry discovery or enter an exact provider/model pair manually."
          action={
            <Button size="small" loading={loading} onClick={() => void retry()}>
              Retry
            </Button>
          }
        />
      )}

      {loading && !configuration && (
        <Flex gap={8} align="center">
          <Spin size="small" />
          <Text type="secondary">Loading OpenCode providers and models…</Text>
        </Flex>
      )}

      {configuration && (
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Select
            aria-label="OpenCode provider"
            showSearch
            value={provider || undefined}
            placeholder="Select a provider"
            options={providerOptions}
            optionFilterProp="searchText"
            getPopupContainer={getPopupContainer}
            onChange={(nextProvider) => {
              setProvider(nextProvider);
              setModel('');
              setManualOpen(false);
            }}
            style={{ width: '100%' }}
          />
          <Select
            aria-label="OpenCode model"
            showSearch
            disabled={!selectedCatalogProvider?.runtimeAvailable}
            value={selectedCatalogProvider && model ? model : undefined}
            placeholder={selectedCatalogProvider ? 'Select a model' : 'Select a provider first'}
            options={modelOptions}
            optionFilterProp="searchText"
            getPopupContainer={getPopupContainer}
            listHeight={320}
            onChange={(nextModel) => selectPair(provider, nextModel)}
            style={{ width: '100%' }}
          />
        </Space>
      )}

      {value && configuration && storedCatalogState === 'unavailable' && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          title={`${value.provider}/${value.model} is not currently available`}
          description="The stored pair is preserved. Connect the provider, choose an available model, or edit the exact IDs below."
        />
      )}

      {value && configuration && storedCatalogState === 'unlisted' && (
        <Alert
          type="info"
          showIcon
          title={`${value.provider}/${value.model} is not in the discovered configuration`}
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
