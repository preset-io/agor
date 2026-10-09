import { Form, Switch } from 'antd';

/** Shared binding and help for full and standalone Codex configuration forms. */
export function CodexPluginsField({ showHelpText = true }: { showHelpText?: boolean }) {
  return (
    <Form.Item
      name="codexIncludePlugins"
      label="Include native Codex plugins"
      valuePropName="checked"
      help={
        showHelpText
          ? 'Off by default. When on, native Codex settings decide which plugins load. Direct MCP connections and standalone skills are unaffected. Existing caches are retained.'
          : undefined
      }
    >
      <Switch />
    </Form.Item>
  );
}
