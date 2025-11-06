import type { ThemeConfig } from 'antd';
import { Alert, Button, Form, Modal, Typography } from 'antd';
import type React from 'react';
import { useEffect } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { JSONEditor, validateJSON } from '../JSONEditor';

const { Text, Link } = Typography;

export interface ThemeEditorModalProps {
  open: boolean;
  onClose: () => void;
}

export const ThemeEditorModal: React.FC<ThemeEditorModalProps> = ({ open, onClose }) => {
  const { customTheme, setCustomTheme, setThemeMode } = useTheme();
  const [form] = Form.useForm();

  // Reset form when modal opens with current custom theme or default
  useEffect(() => {
    if (open) {
      const themeJson = customTheme
        ? JSON.stringify(customTheme, null, 2)
        : getDefaultCustomTheme();
      form.setFieldsValue({ themeConfig: themeJson });
    }
  }, [open, customTheme, form]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const parsed = JSON.parse(values.themeConfig) as ThemeConfig;
      setCustomTheme(parsed);
      setThemeMode('custom');
      onClose();
    } catch (error) {
      // Form validation will show the error
      console.error('Theme validation failed:', error);
    }
  };

  const handleReset = () => {
    form.setFieldsValue({ themeConfig: getDefaultCustomTheme() });
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title="Custom Theme Editor"
      open={open}
      onCancel={handleCancel}
      width={700}
      footer={
        <>
          <Button onClick={handleReset}>Reset to Default</Button>
          <Button onClick={handleCancel}>Cancel</Button>
          <Button type="primary" onClick={handleSave}>
            Save & Apply
          </Button>
        </>
      }
    >
      <Alert
        message="Edit your custom theme configuration"
        description={
          <Text>
            Modify the JSON below to customize your Ant Design theme. See the{' '}
            <Link
              href="https://ant.design/docs/react/customize-theme"
              target="_blank"
              rel="noopener noreferrer"
            >
              Ant Design theme documentation
            </Link>{' '}
            for available options.
          </Text>
        }
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Form form={form} layout="vertical">
        <Form.Item
          name="themeConfig"
          rules={[
            { required: true, message: 'Please enter theme configuration' },
            { validator: validateJSON },
          ]}
        >
          <JSONEditor placeholder="Enter your custom theme JSON configuration..." rows={16} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

function getDefaultCustomTheme(): string {
  return JSON.stringify(
    {
      token: {
        colorPrimary: '#2e9a92',
        colorSuccess: '#52c41a',
        colorWarning: '#faad14',
        colorError: '#ff4d4f',
        colorInfo: '#2e9a92',
        colorLink: '#2e9a92',
        borderRadius: 8,
      },
      // Note: algorithm (dark/light) should be set via the theme switcher dropdown
      // Custom themes will use dark mode by default
    },
    null,
    2
  );
}
