import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Flex,
  Input,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';
import { JSONEditor } from '../JSONEditor';

/**
 * Editor for a card type's `json_schema`, controlled as a JSON string so the
 * parent Form.Item and existing save path (JSON.parse) are unchanged.
 *
 * Default view is a repeatable field list (name / type / required), the common
 * case for a flat object schema. Any schema the list can't round-trip exactly
 * (nested objects, enums, constraints) opens, and stays, in the raw JSON editor.
 */

const FIELD_TYPES = ['string', 'number', 'integer', 'boolean'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

interface SchemaField {
  name: string;
  type: FieldType;
  required: boolean;
}

interface ParsedSchema {
  fields: SchemaField[];
  /** True when the field list round-trips the schema exactly (nothing would be dropped). */
  simple: boolean;
}

/** Key-order-independent form of a schema, with `required` compared as a set. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (key, v) =>
    Array.isArray(v) && key === 'required'
      ? [...v].sort()
      : v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v
  );
}

function parseSchema(raw: string | undefined): ParsedSchema {
  if (!raw?.trim()) return { fields: [], simple: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { fields: [], simple: false };
  }
  if (!parsed || typeof parsed !== 'object') return { fields: [], simple: false };
  const obj = parsed as { properties?: Record<string, { type?: unknown }>; required?: unknown };
  const required = Array.isArray(obj.required) ? (obj.required as string[]) : [];
  const fields: SchemaField[] = [];
  for (const [name, def] of Object.entries(obj.properties ?? {})) {
    const type = def?.type;
    if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
      return { fields: [], simple: false };
    }
    fields.push({ name, type: type as FieldType, required: required.includes(name) });
  }
  // The list only shows name / type / required. Anything else (enum, bounds,
  // additionalProperties, descriptions...) would be dropped on save, so such a
  // schema stays in JSON mode.
  const rebuilt = buildSchema(fields);
  return { fields, simple: canonical(rebuilt ? JSON.parse(rebuilt) : {}) === canonical(parsed) };
}

function buildSchema(fields: SchemaField[]): string {
  const named = fields.filter((f) => f.name.trim());
  if (named.length === 0) return '';
  const properties: Record<string, { type: FieldType }> = {};
  for (const f of named) properties[f.name.trim()] = { type: f.type };
  const required = named.filter((f) => f.required).map((f) => f.name.trim());
  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return JSON.stringify(schema, null, 2);
}

interface CardTypeSchemaEditorProps {
  /** JSON string injected by the parent Form.Item. */
  value?: string;
  onChange?: (value: string) => void;
}

export const CardTypeSchemaEditor: React.FC<CardTypeSchemaEditorProps> = ({ value, onChange }) => {
  const initial = useMemo(() => parseSchema(value), [value]);
  const [fields, setFields] = useState<SchemaField[]>(initial.fields);
  // Fall back to raw JSON automatically when the schema is richer than the list.
  const [jsonMode, setJsonMode] = useState(!initial.simple);

  const commit = (next: SchemaField[]) => {
    setFields(next);
    onChange?.(buildSchema(next));
  };

  const updateField = (index: number, patch: Partial<SchemaField>) =>
    commit(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));

  const addField = () => commit([...fields, { name: '', type: 'string', required: false }]);
  const removeField = (index: number) => commit(fields.filter((_, i) => i !== index));

  const enterFieldMode = () => {
    // Re-parse in case the JSON was hand-edited; stay in JSON mode if it can't
    // be represented as a flat field list, so no data is silently dropped.
    const reparsed = parseSchema(value);
    if (!reparsed.simple) return;
    setFields(reparsed.fields);
    setJsonMode(false);
  };

  return (
    <div>
      <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Fields validate the data stored on each card of this type.
        </Typography.Text>
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Edit as JSON
          </Typography.Text>
          <Switch
            size="small"
            checked={jsonMode}
            onChange={(checked) => (checked ? setJsonMode(true) : enterFieldMode())}
          />
        </Space>
      </Flex>

      {jsonMode ? (
        <>
          {!parseSchema(value).simple && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8 }}
              message="This schema uses features the field list can't show (nested objects, enums, or constraints). Edit it as JSON here."
            />
          )}
          <JSONEditor
            value={value}
            onChange={(next) => onChange?.(next)}
            placeholder='{"type": "object", "properties": {...}}'
            rows={8}
          />
        </>
      ) : fields.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No fields: cards of this type accept any data"
          style={{ margin: '12px 0' }}
        >
          <Button icon={<PlusOutlined />} onClick={addField}>
            Add field
          </Button>
        </Empty>
      ) : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {fields.map((field, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: field rows are positional and reorder-free
            <Flex key={index} gap={8} align="center">
              <Input
                placeholder="field name"
                value={field.name}
                onChange={(e) => updateField(index, { name: e.target.value })}
                style={{ flex: 1 }}
              />
              <Select<FieldType>
                value={field.type}
                onChange={(type) => updateField(index, { type })}
                style={{ width: 120 }}
                options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
              />
              <Checkbox
                checked={field.required}
                onChange={(e) => updateField(index, { required: e.target.checked })}
              >
                Required
              </Checkbox>
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`Remove field ${field.name || index + 1}`}
                onClick={() => removeField(index)}
              />
            </Flex>
          ))}
          <Button icon={<PlusOutlined />} onClick={addField} style={{ alignSelf: 'flex-start' }}>
            Add field
          </Button>
        </Space>
      )}
    </div>
  );
};
