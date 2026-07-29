import type {
  AgenticToolName,
  AgenticToolPreset,
  AgorClient,
  DefaultAgenticToolConfig,
  User,
} from '@agor-live/client';
import {
  canonicalTenantAgenticTool,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { getModelDisplayName } from '../ModelSelector';
import { getPermissionModeLabel } from '../PermissionModeSelector';

export const INLINE_AGENTIC_CONFIGURATION = '__inline__';

export { USER_DEFAULT_AGENTIC_CONFIGURATION, WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION };

/** Match the daemon's raw-tool-first lookup while retaining canonical fallback. */
export function getUserAgenticToolDefault(
  currentUser: User | null | undefined,
  tool: AgenticToolName
) {
  const canonicalTool = canonicalTenantAgenticTool(tool);
  return {
    selection:
      currentUser?.default_agentic_selection?.[tool] ??
      currentUser?.default_agentic_selection?.[canonicalTool],
    configuration:
      currentUser?.default_agentic_config?.[tool] ??
      currentUser?.default_agentic_config?.[canonicalTool],
  };
}

export function getUserDefaultConfigurationSource(
  currentUser: User | null | undefined,
  tool: AgenticToolName
): string | undefined {
  const { selection, configuration } = getUserAgenticToolDefault(currentUser, tool);
  return selection || configuration ? USER_DEFAULT_AGENTIC_CONFIGURATION : undefined;
}

export function summarizeAgenticConfiguration(
  tool: AgenticToolName,
  config?: DefaultAgenticToolConfig
): string {
  if (!config) return '';
  const parts: string[] = [];
  if (config.modelConfig?.model) parts.push(getModelDisplayName(tool, config.modelConfig.model));
  if (config.permissionMode) parts.push(getPermissionModeLabel(tool, config.permissionMode));
  return parts.join(' · ');
}

interface Options {
  tool: AgenticToolName;
  client: AgorClient | null;
  currentUser?: User | null;
}

interface AgenticConfigurationSourceOption {
  value: string;
  title: string;
  summary: string;
  disabled?: boolean;
}

/**
 * Owns preset loading and default-source resolution for every configuration
 * picker. Consumers keep their own rendering and inline form state.
 */
export function useAgenticConfigurationSources({ tool, client, currentUser }: Options) {
  const canonicalTool = canonicalTenantAgenticTool(tool);
  const settings = useAgorStore((state) => state.agenticToolSettingsByName?.get(canonicalTool));
  const inlineAllowed = settings?.inline_configuration_allowed !== false;
  const [presets, setPresets] = useState<AgenticToolPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!client) {
      setPresets([]);
      setLoading(false);
      // Client absence is not a successful empty response. Keep the current
      // source untouched until a client can prove whether that preset exists.
      setLoaded(false);
      setLoadError(false);
      retryRef.current = () => {};
      return undefined;
    }

    let active = true;
    setPresets([]);
    setLoading(true);
    setLoaded(false);
    setLoadError(false);
    const service = client.service('agentic-tool-presets');
    const refresh = async () => {
      if (active) {
        setLoading(true);
        setLoadError(false);
      }
      try {
        const result = await service.find({ query: { tool: canonicalTool } });
        if (!active) return;
        setPresets(Array.isArray(result) ? result : result.data);
        setLoaded(true);
      } catch {
        if (!active) return;
        setLoadError(true);
        setLoaded(false);
      } finally {
        if (active) setLoading(false);
      }
    };
    const onPresetChange = () => {
      void refresh();
    };

    retryRef.current = onPresetChange;
    void refresh();
    service.on('created', onPresetChange);
    service.on('patched', onPresetChange);
    service.on('removed', onPresetChange);
    return () => {
      active = false;
      retryRef.current = () => {};
      service.off('created', onPresetChange);
      service.off('patched', onPresetChange);
      service.off('removed', onPresetChange);
    };
  }, [canonicalTool, client]);

  const retry = useCallback(() => retryRef.current(), []);
  const workspacePreset = presets.find((preset) => preset.is_default);
  const { selection: userSelection, configuration: userConfigBlob } = getUserAgenticToolDefault(
    currentUser,
    tool
  );
  const hasConfiguredUserDefault = currentUser ? Boolean(userSelection ?? userConfigBlob) : true;
  const userDefaultUsesInline = Boolean(
    currentUser &&
      hasConfiguredUserDefault &&
      userSelection?.source !== 'preset' &&
      userSelection?.source !== 'workspace_default'
  );
  const isSourceAllowedByPolicy = useCallback(
    (source: string | undefined) =>
      inlineAllowed ||
      (source !== INLINE_AGENTIC_CONFIGURATION &&
        (source !== USER_DEFAULT_AGENTIC_CONFIGURATION || !userDefaultUsesInline)),
    [inlineAllowed, userDefaultUsesInline]
  );
  const hasUserDefault =
    hasConfiguredUserDefault &&
    isSourceAllowedByPolicy(USER_DEFAULT_AGENTIC_CONFIGURATION) &&
    (!currentUser ||
      (userSelection?.source === 'preset'
        ? presets.some((preset) => preset.preset_id === userSelection.preset_id)
        : userSelection?.source === 'workspace_default'
          ? inlineAllowed || Boolean(workspacePreset)
          : true));

  const resolveConfiguration = useCallback(
    (source: string | undefined, inlineConfig: DefaultAgenticToolConfig = {}) => {
      if (source === INLINE_AGENTIC_CONFIGURATION) return inlineConfig;
      if (source === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
        return workspacePreset?.configuration ?? {};
      if (source === USER_DEFAULT_AGENTIC_CONFIGURATION) {
        if (userSelection?.source === 'preset') {
          return (
            presets.find((preset) => preset.preset_id === userSelection.preset_id)?.configuration ??
            {}
          );
        }
        if (userSelection?.source === 'workspace_default')
          return workspacePreset?.configuration ?? {};
        return userConfigBlob ?? {};
      }
      return presets.find((preset) => preset.preset_id === source)?.configuration ?? {};
    },
    [presets, userConfigBlob, userSelection, workspacePreset]
  );

  const myDefaultSummary = useMemo(() => {
    if (userSelection?.source === 'preset') {
      const preset = presets.find((item) => item.preset_id === userSelection.preset_id);
      if (!preset) return 'preset';
      const summary = summarizeAgenticConfiguration(canonicalTool, preset.configuration);
      return summary ? `${preset.name} · ${summary}` : preset.name;
    }
    if (userSelection?.source === 'workspace_default') {
      return workspacePreset ? `Workspace default · ${workspacePreset.name}` : 'Workspace default';
    }
    return summarizeAgenticConfiguration(canonicalTool, userConfigBlob);
  }, [canonicalTool, presets, userConfigBlob, userSelection, workspacePreset]);

  const isValidSource = useCallback(
    (source: string | undefined) =>
      isSourceAllowedByPolicy(source) &&
      (presets.some((preset) => preset.preset_id === source) ||
        (source === USER_DEFAULT_AGENTIC_CONFIGURATION && hasUserDefault) ||
        (source === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION &&
          (inlineAllowed || Boolean(workspacePreset))) ||
        source === INLINE_AGENTIC_CONFIGURATION),
    [hasUserDefault, inlineAllowed, isSourceAllowedByPolicy, presets, workspacePreset]
  );

  const preferredSource = hasUserDefault
    ? USER_DEFAULT_AGENTIC_CONFIGURATION
    : inlineAllowed
      ? INLINE_AGENTIC_CONFIGURATION
      : workspacePreset
        ? WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
        : presets[0]?.preset_id;

  const sourceOptions = useMemo<AgenticConfigurationSourceOption[]>(
    () => [
      ...(hasUserDefault
        ? [
            {
              value: USER_DEFAULT_AGENTIC_CONFIGURATION,
              title: 'My default',
              summary: myDefaultSummary,
            },
          ]
        : []),
      {
        value: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
        title: workspacePreset
          ? `Workspace default · ${workspacePreset.name}`
          : 'Workspace default',
        summary: workspacePreset
          ? summarizeAgenticConfiguration(canonicalTool, workspacePreset.configuration)
          : 'not configured',
        disabled: !workspacePreset,
      },
      ...presets.map((preset) => ({
        value: preset.preset_id as string,
        title: preset.name,
        summary: summarizeAgenticConfiguration(canonicalTool, preset.configuration),
      })),
      ...(inlineAllowed
        ? [
            {
              value: INLINE_AGENTIC_CONFIGURATION,
              title: 'Customize for this session…',
              summary: '',
            },
          ]
        : []),
    ],
    [canonicalTool, hasUserDefault, inlineAllowed, myDefaultSummary, presets, workspacePreset]
  );

  const getSourceError = useCallback(
    (source: string | undefined): string | undefined => {
      if (loading) return 'Loading configuration';
      if (!source) {
        return loadError ? 'Unable to load configuration presets' : 'Choose a configuration';
      }
      if (!isSourceAllowedByPolicy(source)) {
        return 'This configuration is not allowed by workspace policy';
      }
      // A transient request failure cannot prove that an existing preset
      // disappeared. Preserve it until a successful retry.
      if (loadError) return undefined;
      return isValidSource(source) ? undefined : 'This configuration is no longer available';
    },
    [isSourceAllowedByPolicy, isValidSource, loadError, loading]
  );

  return {
    inlineAllowed,
    presets,
    loading,
    loaded,
    loadError,
    retry,
    resolveConfiguration,
    isValidSource,
    preferredSource,
    sourceOptions,
    getSourceError,
  };
}
