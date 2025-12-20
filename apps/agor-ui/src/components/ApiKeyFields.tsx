import { CheckCircleOutlined, CloseCircleOutlined, DeleteOutlined } from '@ant-design/icons';
import { Button, Input, Space, Typography, theme } from 'antd';
import { useState } from 'react';
import { Tag } from './Tag';

const { Text, Link } = Typography;

export interface ApiKeyStatus {
  ANTHROPIC_API_KEY: boolean;
  OPENAI_API_KEY: boolean;
  GEMINI_API_KEY: boolean;
}

export interface ApiKeyFieldsProps {
  /** Current status of each key (true = set, false = not set). Can be a partial set of keys. */
  keyStatus: Partial<ApiKeyStatus>;
  /** Callback when user saves a new key */
  onSave: (field: keyof ApiKeyStatus, value: string) => Promise<void>;
  /** Callback when user clears a key */
  onClear: (field: keyof ApiKeyStatus) => Promise<void>;
  /** Loading state for save/clear operations */
  saving?: Record<string, boolean>;
  /** Disable all fields */
  disabled?: boolean;
}

interface KeyFieldConfig {
  field: keyof ApiKeyStatus;
  label: string;
  description: string;
  placeholder: string;
  docUrl: string;
}

const KEY_CONFIGS: KeyFieldConfig[] = [
  {
    field: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    description: '(Claude Code / Agent SDK)',
    placeholder: 'sk-ant-api03-...',
    docUrl: 'https://console.anthropic.com',
  },
  {
    field: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    description: '(Codex)',
    placeholder: 'sk-proj-...',
    docUrl: 'https://platform.openai.com/api-keys',
  },
  {
    field: 'GEMINI_API_KEY',
    label: 'Gemini API Key',
    description: '',
    placeholder: 'AIza...',
    docUrl: 'https://aistudio.google.com/app/apikey',
  },
];

export const ApiKeyFields: React.FC<ApiKeyFieldsProps> = ({
  keyStatus,
  onSave,
  onClear,
  saving = {},
  disabled = false,
}) => {
  const { token } = theme.useToken();
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  const handleSave = async (field: keyof ApiKeyStatus) => {
    const value = inputValues[field]?.trim();
    if (!value) return;

    await onSave(field, value);
    setInputValues((prev) => ({ ...prev, [field]: '' }));
  };

  const renderKeyField = (config: KeyFieldConfig) => {
    const { field, label, description, placeholder, docUrl } = config;
    const isSet = keyStatus[field];

    return (
      <div key={field} style={{ marginBottom: token.marginLG }}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space>
            <Text strong>{label}</Text>
            {description && <Text type="secondary">{description}</Text>}
            {isSet ? (
              <Tag icon={<CheckCircleOutlined />} color="success">
                Set
              </Tag>
            ) : (
              <Tag icon={<CloseCircleOutlined />} color="default">
                Not Set
              </Tag>
            )}
          </Space>

          {isSet ? (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => onClear(field)}
              loading={saving[field]}
              disabled={disabled}
            >
              Clear Key
            </Button>
          ) : (
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                placeholder={placeholder}
                value={inputValues[field] || ''}
                onChange={(e) => setInputValues((prev) => ({ ...prev, [field]: e.target.value }))}
                onPressEnter={() => handleSave(field)}
                style={{ flex: 1 }}
                disabled={disabled}
              />
              <Button
                type="primary"
                onClick={() => handleSave(field)}
                loading={saving[field]}
                disabled={disabled || !inputValues[field]?.trim()}
              >
                Save
              </Button>
            </Space.Compact>
          )}

          <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            Get your key at:{' '}
            <Link href={docUrl} target="_blank">
              {docUrl}
            </Link>
          </Text>
        </Space>
      </div>
    );
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {KEY_CONFIGS.filter((config) => config.field in keyStatus).map((config) =>
        renderKeyField(config)
      )}
    </Space>
  );
};
