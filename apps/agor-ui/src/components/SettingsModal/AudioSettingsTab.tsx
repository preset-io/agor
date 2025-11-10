/**
 * AudioSettingsTab - Configure task completion chime settings
 */

import type { UpdateUserInput, User } from '@agor/core/types';
import type { ChimeSound } from '@agor/core/types/user';
import { PlayCircleOutlined, SoundOutlined } from '@ant-design/icons';
import { Button, Card, Form, InputNumber, Select, Slider, Space, Switch, Typography, message } from 'antd';
import { useState } from 'react';
import {
  DEFAULT_AUDIO_PREFERENCES,
  getAvailableChimes,
  getChimeDisplayName,
  previewChimeSound,
} from '../../utils/audio';

const { Text, Paragraph } = Typography;

interface AudioSettingsTabProps {
  currentUser: User | null;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
}

export const AudioSettingsTab: React.FC<AudioSettingsTabProps> = ({ currentUser, onUpdateUser }) => {
  const [form] = Form.useForm();
  const [isPlaying, setIsPlaying] = useState(false);

  // Get current audio preferences or use defaults
  const audioPrefs = currentUser?.preferences?.audio || DEFAULT_AUDIO_PREFERENCES;

  const handleSave = async () => {
    if (!currentUser || !onUpdateUser) return;

    try {
      const values = form.getFieldsValue();
      const updatedPreferences = {
        ...currentUser.preferences,
        audio: {
          enabled: values.enabled,
          chime: values.chime,
          volume: values.volume,
          minDurationSeconds: values.minDurationSeconds,
        },
      };

      onUpdateUser(currentUser.user_id, {
        preferences: updatedPreferences,
      });

      message.success('Audio settings saved');
    } catch (error) {
      message.error('Failed to save audio settings');
      console.error('Failed to save audio settings:', error);
    }
  };

  const handlePreview = async () => {
    const chime = form.getFieldValue('chime');
    const volume = form.getFieldValue('volume');

    setIsPlaying(true);
    try {
      await previewChimeSound(chime, volume);
    } catch (error) {
      message.error('Failed to play preview. Check browser permissions.');
    } finally {
      // Reset after a short delay (chimes are ~1-2 seconds)
      setTimeout(() => setIsPlaying(false), 2000);
    }
  };

  const handleEnableToggle = (enabled: boolean) => {
    if (enabled) {
      // When enabling, show a message about browser permissions
      message.info('Audio notifications enabled. Use the preview button to test.');
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Text strong style={{ fontSize: 16 }}>
              <SoundOutlined /> Task Completion Chimes
            </Text>
            <Paragraph type="secondary" style={{ marginTop: 8 }}>
              Play a sound when agent tasks finish executing. Perfect for long-running tasks!
            </Paragraph>
          </div>

          <Form
            form={form}
            layout="vertical"
            initialValues={{
              enabled: audioPrefs.enabled,
              chime: audioPrefs.chime,
              volume: audioPrefs.volume,
              minDurationSeconds: audioPrefs.minDurationSeconds,
            }}
            onFinish={handleSave}
          >
            {/* Enable/Disable Toggle */}
            <Form.Item name="enabled" label="Enable Chimes" valuePropName="checked">
              <Switch onChange={handleEnableToggle} />
            </Form.Item>

            {/* Chime Selection */}
            <Form.Item
              name="chime"
              label="Chime Sound"
              tooltip="Choose your preferred notification sound"
            >
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  style={{ flex: 1 }}
                  disabled={!form.getFieldValue('enabled')}
                  options={getAvailableChimes().map((chime) => ({
                    label: getChimeDisplayName(chime),
                    value: chime,
                  }))}
                />
                <Button
                  icon={<PlayCircleOutlined />}
                  onClick={handlePreview}
                  disabled={!form.getFieldValue('enabled') || isPlaying}
                  loading={isPlaying}
                >
                  Preview
                </Button>
              </Space.Compact>
            </Form.Item>

            {/* Volume Slider */}
            <Form.Item name="volume" label="Volume">
              <Slider
                min={0}
                max={1}
                step={0.1}
                marks={{
                  0: '0%',
                  0.5: '50%',
                  1: '100%',
                }}
                disabled={!form.getFieldValue('enabled')}
                tooltip={{ formatter: (value) => `${Math.round((value || 0) * 100)}%` }}
              />
            </Form.Item>

            {/* Minimum Duration */}
            <Form.Item
              name="minDurationSeconds"
              label="Minimum Task Duration"
              tooltip="Only play chime for tasks that take longer than this. Set to 0 to always play."
            >
              <InputNumber
                min={0}
                max={60}
                step={1}
                addonAfter="seconds"
                style={{ width: 200 }}
                disabled={!form.getFieldValue('enabled')}
              />
            </Form.Item>

            {/* Save Button */}
            <Form.Item>
              <Button type="primary" htmlType="submit">
                Save Settings
              </Button>
            </Form.Item>
          </Form>

          {/* Info Section */}
          <Card type="inner" size="small">
            <Text type="secondary">
              <strong>Note:</strong> Chimes will only play for tasks that complete naturally (finished
              or failed), not for tasks you manually stop. Make sure your browser allows audio playback
              - click the Preview button to test!
            </Text>
          </Card>
        </Space>
      </Card>
    </div>
  );
};
