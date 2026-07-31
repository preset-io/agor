import type { AgorClient } from '@agor/core/client';
import type { OpenCodeModelCatalog } from '@agor/core/types';
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
import { useOpenCodeModelCatalog } from './useOpenCodeModelCatalog';

const { Text } = Typography;

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
  refreshFailed: boolean,
  storedUnavailable: boolean
): string | undefined {
  if (!catalogEnabled) {
    return 'Configured models are private to the session owner. Their stored exact pair remains usable.';
  }
  if (refreshFailed) {
    return 'Configured models could not be refreshed. The stored selection was not changed.';
  }
  if (storedUnavailable) {
    return 'The stored pair is not in the current configured catalog.';
  }
  return undefined;
}

const modelPairValue = (providerId: string, modelId: string) =>
  JSON.stringify([providerId, modelId]);

function compactModelOptions(
  catalog: OpenCodeModelCatalog | null,
  value: OpenCodeModelConfig | undefined,
  storedUnavailable: boolean
) {
  const groups =
    catalog?.providers.map((provider) => ({
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
  catalog: OpenCodeModelCatalog | null;
  catalogEnabled: boolean;
  client?: AgorClient | null;
  loading: boolean;
  refreshFailed: boolean;
  storedAvailable: boolean;
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
  refreshFailed,
  storedAvailable,
  manualFields,
  manualOpen,
  setManualOpen,
  refresh,
  selectPair,
  getPopupContainer,
}: CompactOpenCodeModelSelectorProps) {
  const storedUnavailable = Boolean(value && catalog && !storedAvailable);
  const { groups, selectedValue } = compactModelOptions(catalog, value, storedUnavailable);
  const warning = compactWarning(catalogEnabled, refreshFailed, storedUnavailable);

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
      {catalogEnabled && client && (
        <Tooltip title="Refresh configured models">
          <Button
            aria-label="Refresh configured models"
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
 * Configured OpenCode model selection. Discovery is a disposable, protected
 * read; manual exact entry remains usable when it is unavailable.
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
  const { catalog, loading, refreshFailed, refresh } = useOpenCodeModelCatalog({
    client,
    branchId,
    catalogEnabled,
  });

  useEffect(() => {
    setProvider(value?.provider ?? '');
    setModel(value?.model ?? '');
  }, [value?.provider, value?.model]);

  useEffect(() => {
    if (!catalogEnabled) setManualOpen(!compact);
  }, [catalogEnabled, compact]);

  const storedAvailable = useMemo(() => {
    if (!value || !catalog) return true;
    return catalog.providers.some(
      (entry) =>
        entry.id === value.provider &&
        entry.runtimeAvailable &&
        entry.models.some((candidate) => candidate.id === value.model)
    );
  }, [catalog, value]);

  useEffect(() => {
    if (!compact && catalog && !storedAvailable) setManualOpen(true);
  }, [catalog, compact, storedAvailable]);

  const selectPair = (nextProvider: string, nextModel: string) => {
    setProvider(nextProvider);
    setModel(nextModel);
    setManualOpen(false);
    setCompactManualOpen(false);
    onChange?.({ provider: nextProvider, model: nextModel });
  };

  useEffect(() => {
    if (value || !catalog?.suggestedSelection) return;
    const { providerId, modelId } = catalog.suggestedSelection;
    const suggestionKey = `${branchId ?? ''}\0${providerId}\0${modelId}`;
    if (appliedSuggestionRef.current === suggestionKey) return;
    appliedSuggestionRef.current = suggestionKey;
    setProvider(providerId);
    setModel(modelId);
    setManualOpen(false);
    setCompactManualOpen(false);
    onChange?.({ provider: providerId, model: modelId });
  }, [branchId, catalog?.suggestedSelection, onChange, value]);

  const selectedCatalogProvider = catalog?.providers.find((entry) => entry.id === provider);
  const providerOptions =
    catalog?.providers.map((entry) => ({
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
        catalog={catalog}
        catalogEnabled={catalogEnabled}
        client={client}
        loading={loading}
        refreshFailed={refreshFailed}
        storedAvailable={storedAvailable}
        manualFields={manualFields}
        manualOpen={compactManualOpen}
        setManualOpen={setCompactManualOpen}
        refresh={refresh}
        selectPair={selectPair}
        getPopupContainer={getPopupContainer}
      />
    );
  }

  return (
    <Space orientation="vertical" size={10} style={{ width: '100%' }}>
      <Flex gap={8} wrap="wrap">
        {catalogEnabled && client && (
          <Button
            aria-label="Refresh configured models"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        )}
      </Flex>

      {!catalogEnabled && (
        <Alert
          type="info"
          showIcon
          title="Configured models are private to the session owner"
          description="Execution uses the immutable session owner's OpenCode credentials. Their catalog is not shown to collaborators; keep the stored exact pair or enter exact IDs manually."
        />
      )}

      {refreshFailed && (
        <Alert
          type="warning"
          showIcon
          title="Could not refresh the configured model catalog"
          description="The stored selection was not changed. Enter an exact provider/model pair manually if needed."
        />
      )}

      {loading && !catalog && (
        <Flex gap={8} align="center">
          <Spin size="small" />
          <Text type="secondary">Loading configured OpenCode models…</Text>
        </Flex>
      )}

      {catalog?.projectConfigured && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          <SettingOutlined /> Project configuration currently names{' '}
          <Text code>
            {catalog.projectConfigured.providerId}/{catalog.projectConfigured.modelId}
          </Text>
          . Select and store the exact pair in Agor before running the session.
        </Text>
      )}

      {catalog && (
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Select
            aria-label="OpenCode provider"
            showSearch
            value={provider || undefined}
            placeholder="Select a configured provider"
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

      {value && catalog && !storedAvailable && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          title={`${value.provider}/${value.model} is not in the current configured catalog`}
          description="The stored pair is preserved. Refresh, choose an available configured model, or edit the exact IDs below."
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
