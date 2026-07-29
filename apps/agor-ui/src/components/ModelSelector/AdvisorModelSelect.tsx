import { type AgorClient, AVAILABLE_CLAUDE_MODEL_ALIASES } from '@agor-live/client';
import { Select, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { type NormalizedModelOption, normalizeModelOption } from './modelDefaults';

interface DynamicModelsResponse {
  models: Array<{ id: string; displayName: string; description?: string }>;
}

export interface AdvisorModelSelectProps {
  value?: string;
  onChange?: (advisorModel: string | undefined) => void;
  /** When set, fetches the live Claude model list; otherwise uses the static aliases. */
  client?: AgorClient | null;
  /** Preloaded options — skips the fetch when the parent already has them. */
  options?: Array<{ id: string; displayName?: string; label?: string; description?: string }>;
  size?: 'small' | 'middle' | 'large';
  style?: React.CSSProperties;
}

/**
 * Optional Claude Code advisor-tool model. `allowClear` → `undefined` disables
 * the session-level override. Extracted from ModelSelector so surfaces can
 * place the advisor in an "Advanced" area instead of beside the main model.
 */
export const AdvisorModelSelect: React.FC<AdvisorModelSelectProps> = ({
  value,
  onChange,
  client,
  options,
  size,
  style,
}) => {
  const [fetched, setFetched] = useState<NormalizedModelOption[] | null>(null);

  useEffect(() => {
    if (options || !client) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = (await client.service('claude-models').find()) as unknown as
          | DynamicModelsResponse
          | undefined;
        if (cancelled || !raw?.models?.length) return;
        setFetched(raw.models.map(normalizeModelOption));
      } catch {
        // Best-effort: fall back to the static alias list below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, options]);

  const list: NormalizedModelOption[] = options
    ? options.map(normalizeModelOption)
    : (fetched ?? AVAILABLE_CLAUDE_MODEL_ALIASES.map(normalizeModelOption));

  return (
    <Select
      allowClear
      showSearch
      size={size}
      optionFilterProp="label"
      placeholder="Off — uses your Claude settings"
      value={value}
      onChange={onChange}
      popupMatchSelectWidth={false}
      style={{ width: '100%', ...style }}
      options={list.map((model) => ({ value: model.id, label: model.displayName }))}
      optionRender={(option) => {
        const model = list.find((m) => m.id === option.value);
        return (
          <div style={{ lineHeight: 1.3 }}>
            <div>{model?.displayName ?? option.label}</div>
            {model?.description && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {model.description}
              </Typography.Text>
            )}
          </div>
        );
      }}
    />
  );
};
