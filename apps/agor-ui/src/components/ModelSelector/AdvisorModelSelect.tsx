import { type AgorClient, AVAILABLE_CLAUDE_MODEL_ALIASES } from '@agor-live/client';
import { Radio, Select, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { type NormalizedModelOption, normalizeModelOption } from './modelDefaults';

/** Sentinel radio value for "Off" (no advisor override) in list mode. */
const ADVISOR_OFF_VALUE = '__off__';

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
  /**
   * `select` (default) shows a searchable dropdown. `list` renders the models
   * directly as a values-first radio list (with an explicit "Off") for popover
   * surfaces where one click should reveal the options with no nested dropdown.
   */
  variant?: 'select' | 'list';
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
  variant = 'select',
}) => {
  const { token } = theme.useToken();
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

  // Values-first list: render "Off" plus each model directly so a popover shows
  // them on the first click, with no nested searchable dropdown.
  if (variant === 'list') {
    return (
      <Radio.Group
        value={value ?? ADVISOR_OFF_VALUE}
        onChange={(e) =>
          onChange?.(e.target.value === ADVISOR_OFF_VALUE ? undefined : e.target.value)
        }
        style={{ display: 'flex', flexDirection: 'column', gap: token.marginXS, width: '100%' }}
      >
        <Radio value={ADVISOR_OFF_VALUE} style={{ alignItems: 'flex-start' }}>
          <div style={{ lineHeight: 1.3 }}>
            <div>Off</div>
            <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
              Uses your Claude settings
            </Typography.Text>
          </div>
        </Radio>
        {list.map((model) => (
          <Radio key={model.id} value={model.id} style={{ alignItems: 'flex-start' }}>
            <div style={{ lineHeight: 1.3 }}>
              <div>{model.displayName}</div>
              {model.description && (
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: token.fontSizeSM, whiteSpace: 'normal' }}
                >
                  {model.description}
                </Typography.Text>
              )}
            </div>
          </Radio>
        ))}
      </Radio.Group>
    );
  }

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
