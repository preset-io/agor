/**
 * AudioSettingsTab - Configure task completion chime settings
 */

import type { ChimeSound, UpdateUserInput, User } from '@agor/core/types';
import { PlayCircleOutlined, SoundOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  message,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useState } from 'react';
import {
  DEFAULT_AUDIO_PREFERENCES,
  getAvailableChimes,
  getChimeDisplayName,
  previewChimeSound,
} from '../../utils/audio';

const { Text, Paragraph } = Typography;

interface AudioSettingsTabProps {
  user: User | null;
  form: ReturnType<typeof Form.useForm>[0];
}

export const AudioSettingsTab: React.FC<AudioSettingsTabProps> = ({ user, form }) => {
  const [isPlaying, setIsPlaying] = useState(false);

  // Get current audio preferences or use defaults
  const audioPrefs = user?.preferences?.audio || DEFAULT_AUDIO_PREFERENCES;

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
    <div>
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ fontSize: 16 }}>
          <SoundOutlined /> Task Completion Chimes
        </Text>
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
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
      >
        <Row gutter={16}>
          {/* Enable/Disable Toggle */}
          <Col span={12}>
            <Form.Item name="enabled" label="Enable Chimes" valuePropName="checked">
              <Switch onChange={handleEnableToggle} />
            </Form.Item>
          </Col>

          {/* Volume Slider */}
          <Col span={12}>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.enabled !== curr.enabled}>
              {() => (
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
                    tooltip={{ formatter: value => `${Math.round((value || 0) * 100)}%` }}
                  />
                </Form.Item>
              )}
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          {/* Chime Selection */}
          <Col span={12}>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.enabled !== curr.enabled}>
              {() => {
                const enabled = form.getFieldValue('enabled');
                return (
                  <Form.Item label="Chime Sound" tooltip="Choose your preferred notification sound">
                    <Space.Compact style={{ width: '100%' }}>
                      <Form.Item name="chime" noStyle>
                        <Select
                          style={{ flex: 1 }}
                          disabled={!enabled}
                          options={getAvailableChimes().map(chime => ({
                            label: getChimeDisplayName(chime),
                            value: chime,
                          }))}
                        />
                      </Form.Item>
                      <Button
                        icon={<PlayCircleOutlined />}
                        onClick={handlePreview}
                        disabled={!enabled || isPlaying}
                        loading={isPlaying}
                      >
                        Preview
                      </Button>
                    </Space.Compact>
                  </Form.Item>
                );
              }}
            </Form.Item>
          </Col>

          {/* Minimum Duration */}
          <Col span={12}>
            <Form.Item noStyle shouldUpdate={(prev, curr) => prev.enabled !== curr.enabled}>
              {() => (
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
                    style={{ width: '100%' }}
                    disabled={!form.getFieldValue('enabled')}
                  />
                </Form.Item>
              )}
            </Form.Item>
          </Col>
        </Row>
      </Form>

      {/* Info Section */}
      <Card type="inner" size="small" style={{ marginTop: 16 }}>
        <Text type="secondary">
          <strong>Note:</strong> Chimes will only play for tasks that complete naturally (finished
          or failed), not for tasks you manually stop. Make sure your browser allows audio playback
          - click the Preview button to test!
        </Text>
      </Card>
    </div>
  );
};
