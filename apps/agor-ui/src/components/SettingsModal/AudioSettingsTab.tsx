/**
 * AudioSettingsTab - Configure task completion chime settings
 */

import type { User } from '@agor-live/client';
import { InfoCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Form,
  InputNumber,
  Select,
  Slider,
  Space,
  Switch,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import {
  checkAudioPermission,
  DEFAULT_AUDIO_PREFERENCES,
  getAvailableChimes,
  getChimeDisplayName,
  MIN_DURATION_MAX,
  MIN_DURATION_MIN,
  previewChimeSound,
} from '../../utils/audio';
import { useThemedMessage } from '../../utils/message';
import { FieldRow } from './panelPrimitives';

const { Text, Paragraph } = Typography;

interface AudioSettingsTabProps {
  user: User | null;
  form: ReturnType<typeof Form.useForm>[0];
}

export const AudioSettingsTab: React.FC<AudioSettingsTabProps> = ({ user, form }) => {
  const { token } = theme.useToken();
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
        <Text strong style={{ fontSize: token.fontSizeLG }}>
          🔊 Task Completion Chimes
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
          title="Browser Audio Permissions Required"
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
              <p style={{ marginBottom: 0, fontSize: token.fontSizeSM, opacity: 0.8 }}>
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
        requiredMark={false}
        initialValues={{
          enabled: audioPrefs.enabled,
          chime: audioPrefs.chime,
          volume: audioPrefs.volume,
          minDurationSeconds: audioPrefs.minDurationSeconds,
        }}
      >
        <FieldRow label="Enable chimes" name="enabled" valuePropName="checked">
          <Switch onChange={handleEnableToggle} />
        </FieldRow>

        <Form.Item noStyle shouldUpdate={(prev, curr) => prev.enabled !== curr.enabled}>
          {() => (
            <FieldRow label="Volume">
              <Form.Item name="volume" noStyle>
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  disabled={!form.getFieldValue('enabled')}
                  tooltip={{ formatter: (value) => `${Math.round((value || 0) * 100)}%` }}
                  style={{ maxWidth: 360 }}
                />
              </Form.Item>
            </FieldRow>
          )}
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(prev, curr) => prev.enabled !== curr.enabled}>
          {() => {
            const enabled = form.getFieldValue('enabled');
            return (
              <FieldRow label="Chime sound">
                <Space.Compact style={{ width: '100%', maxWidth: 360 }}>
                  <Form.Item name="chime" noStyle>
                    <Select
                      style={{ flex: 1 }}
                      disabled={!enabled}
                      options={getAvailableChimes()
                        .map((chime) => ({
                          label: getChimeDisplayName(chime),
                          value: chime,
                        }))
                        .sort((a, b) => a.label.localeCompare(b.label))}
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
              </FieldRow>
            );
          }}
        </Form.Item>

        <Form.Item noStyle shouldUpdate={(prev, curr) => prev.enabled !== curr.enabled}>
          {() => (
            <FieldRow
              label="Only play for tasks longer than"
              help="Set to 0 to always play. Chimes never play for tasks you stop manually."
            >
              <Form.Item name="minDurationSeconds" noStyle>
                <InputNumber
                  min={MIN_DURATION_MIN}
                  max={MIN_DURATION_MAX}
                  step={1}
                  addonAfter="seconds"
                  disabled={!form.getFieldValue('enabled')}
                  style={{ width: 220 }}
                />
              </Form.Item>
            </FieldRow>
          )}
        </Form.Item>
      </Form>

      <Card type="inner" size="small">
        <Text type="secondary">
          <strong>Note:</strong> chimes only play for tasks that complete naturally (finished or
          failed), not for tasks you manually stop. Click Preview to confirm your browser allows
          audio playback.
        </Text>
      </Card>
    </div>
  );
};
