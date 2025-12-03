/**
 * AudioSettingsTab - Configure task completion chime settings
 */

import type { User } from '@agor/core/types';
import { InfoCircleOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import {
  checkAudioPermission,
  DEFAULT_AUDIO_PREFERENCES,
  getAvailableChimes,
  getChimeDisplayName,
  previewChimeSound,
} from '../../utils/audio';
import { useThemedMessage } from '../../utils/message';

const { Text, Paragraph } = Typography;

interface AudioSettingsTabProps {
  user: User | null;
  form: ReturnType<typeof Form.useForm>[0];
}

export const AudioSettingsTab: React.FC<AudioSettingsTabProps> = ({ user, form }) => {
  const { showError, showWarning, showInfo } = useThemedMessage();
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState<boolean | null>(null);
  const [showPermissionAlert, setShowPermissionAlert] = useState(false);

  // Get current audio preferences or use defaults
  const audioPrefs = user?.preferences?.audio || DEFAULT_AUDIO_PREFERENCES;

  // Check audio permission on mount
  useEffect(() => {
    checkAudioPermission().then(setAudioBlocked);
  }, []);

  const handlePreview = async () => {
    const chime = form.getFieldValue('chime');
    const volume = form.getFieldValue('volume');

    setIsPlaying(true);
    setShowPermissionAlert(false);
    try {
      await previewChimeSound(chime, volume);
      // If preview works, update permission status
      setAudioBlocked(false);
    } catch (_error) {
      setAudioBlocked(true);
      setShowPermissionAlert(true);
      showError('Audio blocked by browser. See instructions below to enable.');
    } finally {
      // Reset after a short delay (chimes are ~1-2 seconds)
      setTimeout(() => setIsPlaying(false), 2000);
    }
  };

  const handleEnableToggle = async (enabled: boolean) => {
    if (enabled) {
      // Check permission when enabling
      const blocked = await checkAudioPermission();
      setAudioBlocked(blocked);
      if (blocked) {
        setShowPermissionAlert(true);
        showWarning('Audio may be blocked. Click Preview to test and grant permissions.');
      } else {
        showInfo('Audio notifications enabled. Use the preview button to test.');
      }
    } else {
      setShowPermissionAlert(false);
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

      {/* Browser Permission Alert */}
      {showPermissionAlert && audioBlocked && (
        <Alert
          type="warning"
          showIcon
          icon={<InfoCircleOutlined />}
          message="Browser Audio Permissions Required"
          description={
            <div>
              <p style={{ marginBottom: 8 }}>
                Your browser is blocking audio playback. To enable chimes:
              </p>
              <ol style={{ marginLeft: 16, marginBottom: 8 }}>
                <li>
                  Click the <strong>lock icon</strong> (🔒) or <strong>site info icon</strong> in
                  your browser's address bar
                </li>
                <li>
                  Find <strong>"Sound"</strong> or <strong>"Autoplay"</strong> permissions
                </li>
                <li>
                  Change the setting to <strong>"Allow"</strong>
                </li>
                <li>Refresh the page and click the Preview button again</li>
              </ol>
              <p style={{ marginBottom: 0, fontSize: '0.9em', opacity: 0.8 }}>
                <strong>Chrome/Edge:</strong> Click lock icon → Site settings → Sound → Allow
                <br />
                <strong>Firefox:</strong> Click lock icon → Permissions → Autoplay → Allow Audio and
                Video
                <br />
                <strong>Safari:</strong> Safari → Settings for this Website → Auto-Play → Allow All
                Auto-Play
              </p>
            </div>
          }
          closable
          onClose={() => setShowPermissionAlert(false)}
          style={{ marginBottom: 16 }}
        />
      )}

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
                    tooltip={{ formatter: (value) => `${Math.round((value || 0) * 100)}%` }}
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
                          options={getAvailableChimes().map((chime) => ({
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
                  <Space.Compact style={{ width: '100%' }}>
                    <InputNumber
                      min={0}
                      max={60}
                      step={1}
                      style={{ width: '100%' }}
                      disabled={!form.getFieldValue('enabled')}
                    />
                    <Input
                      value="seconds"
                      disabled
                      style={{ width: 80, textAlign: 'center', pointerEvents: 'none' }}
                    />
                  </Space.Compact>
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
