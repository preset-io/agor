import { AudioMutedOutlined, AudioOutlined, LoadingOutlined } from '@ant-design/icons';
import { Button, Progress, Tooltip, theme } from 'antd';
import type React from 'react';
import { useVoiceTranscription } from '../../hooks/useVoiceTranscription';

interface VoiceMicButtonProps {
  onInsertText: (text: string) => void;
}

export const VoiceMicButton: React.FC<VoiceMicButtonProps> = ({ onInsertText }) => {
  const { token } = theme.useToken();
  const { state, isSupported, error, progress, toggleRecording } =
    useVoiceTranscription(onInsertText);

  if (!isSupported) {
    return (
      <Tooltip title="Voice input requires WebGPU, which is not available in this browser. Try Chrome 113+ or Edge 113+.">
        <Button
          size="small"
          type="text"
          icon={<AudioMutedOutlined />}
          disabled
          aria-label="Voice input (unsupported)"
        />
      </Tooltip>
    );
  }

  const isActive =
    state === 'recording' ||
    state === 'loading-model' ||
    state === 'requesting-permission' ||
    state === 'transcribing';

  const tooltipContent = (() => {
    if (state === 'loading-model') {
      return (
        <div style={{ minWidth: 180 }}>
          <div style={{ marginBottom: 4 }}>{progress?.message ?? 'Loading Whisper model…'}</div>
          <div style={{ fontSize: 11, color: token.colorTextSecondary, marginBottom: 6 }}>
            First use only — model is cached locally after download.
          </div>
          {progress?.value != null && (
            <Progress
              percent={Math.round(progress.value * 100)}
              size="small"
              showInfo={false}
              strokeColor={token.colorPrimary}
            />
          )}
        </div>
      );
    }
    if (state === 'requesting-permission') return 'Requesting microphone access…';
    if (state === 'recording') return 'Recording… click to stop and transcribe';
    if (state === 'transcribing') return 'Transcribing…';
    if (state === 'error') return error ? `Error: ${error} — click to retry` : 'Click to retry';
    return 'Voice input (WebGPU Whisper)';
  })();

  const icon = (() => {
    if (
      state === 'loading-model' ||
      state === 'transcribing' ||
      state === 'requesting-permission'
    ) {
      return <LoadingOutlined />;
    }
    if (state === 'recording') return <AudioOutlined style={{ color: token.colorError }} />;
    if (state === 'error') return <AudioMutedOutlined style={{ color: token.colorError }} />;
    return <AudioOutlined />;
  })();

  return (
    <Tooltip
      title={tooltipContent}
      placement="top"
      open={isActive || state === 'error' ? true : undefined}
    >
      <Button
        size="small"
        type={state === 'recording' ? 'primary' : 'text'}
        danger={state === 'recording'}
        icon={icon}
        onClick={toggleRecording}
        disabled={
          state === 'loading-model' || state === 'requesting-permission' || state === 'transcribing'
        }
        aria-label={
          state === 'recording'
            ? 'Stop recording'
            : state === 'transcribing'
              ? 'Transcribing…'
              : 'Start voice input'
        }
        data-testid="voice-mic-btn"
        style={
          state === 'recording'
            ? {
                animation: 'agor-mic-pulse 1.2s ease-in-out infinite',
              }
            : undefined
        }
      />
    </Tooltip>
  );
};
