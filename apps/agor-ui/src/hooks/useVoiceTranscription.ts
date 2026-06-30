import React from 'react';

// The tiny English-only Whisper model — fast download (~40 MB), good accuracy
// for English. Swap to 'onnx-community/whisper-base' for multilingual support
// at ~150 MB, or 'onnx-community/whisper-small' for higher accuracy.
const WHISPER_MODEL_ID = 'onnx-community/whisper-tiny.en';

export type VoiceState =
  | 'idle'
  | 'loading-model'
  | 'requesting-permission'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface VoiceProgress {
  /** 0–1 overall download progress, null when not downloading */
  value: number | null;
  message: string;
}

export interface UseVoiceTranscriptionResult {
  state: VoiceState;
  /** True when both navigator.gpu and getUserMedia are available */
  isSupported: boolean;
  /** Human-readable error message, set when state === 'error' */
  error: string | null;
  /** Download progress during 'loading-model' state */
  progress: VoiceProgress | null;
  /** Toggle recording on/off */
  toggleRecording: () => void;
}

// ---------------------------------------------------------------------------
// Module-level singleton so the pipeline is only loaded once per page session
// ---------------------------------------------------------------------------
let pipelinePromise: Promise<unknown> | null = null;
let pipeline: unknown = null;

function detectSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

async function resampleTo16kHz(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  // Decode at native sample rate first
  const decodeCtx = new AudioContext();
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  await decodeCtx.close();

  const targetRate = 16000;
  if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }

  // Resample + downmix to mono 16kHz via OfflineAudioContext
  const frameCount = Math.ceil(decoded.duration * targetRate);
  const offlineCtx = new OfflineAudioContext(1, frameCount, targetRate);
  const src = offlineCtx.createBufferSource();
  src.buffer = decoded;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

export function useVoiceTranscription(
  onTranscript: (text: string) => void
): UseVoiceTranscriptionResult {
  const [state, setState] = React.useState<VoiceState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<VoiceProgress | null>(null);

  const isSupported = React.useMemo(() => detectSupport(), []);

  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const onTranscriptRef = React.useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stopStream = React.useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, []);

  const startRecording = React.useCallback(async () => {
    setError(null);

    // Lazy-load the pipeline singleton on first use
    if (!pipeline) {
      setState('loading-model');
      try {
        if (!pipelinePromise) {
          pipelinePromise = (async () => {
            // Dynamic import keeps transformers.js out of the initial bundle
            const { pipeline: createPipeline } = await import('@huggingface/transformers');

            const progressCallback = (info: {
              status: string;
              name?: string;
              file?: string;
              loaded?: number;
              total?: number;
              progress?: number;
            }) => {
              // transformers.js v4 status values: 'initiate', 'download',
              // 'progress' (per-file), 'progress_total', 'done', 'ready'
              if (
                info.status === 'download' ||
                info.status === 'progress' ||
                info.status === 'progress_total'
              ) {
                // progress is 0–100 in v4
                const pct =
                  info.progress != null
                    ? info.progress / 100
                    : info.loaded != null && info.total
                      ? info.loaded / info.total
                      : null;
                setProgress({
                  value: pct,
                  message: info.file
                    ? `Downloading ${info.file}…`
                    : info.name
                      ? `Loading ${info.name}…`
                      : 'Downloading model…',
                });
              } else if (info.status === 'done' || info.status === 'ready') {
                setProgress((prev) =>
                  prev ? { ...prev, message: 'Finalizing…' } : { value: 1, message: 'Finalizing…' }
                );
              }
            };

            return createPipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
              device: 'webgpu',
              dtype: 'fp32',
              progress_callback: progressCallback,
            });
          })();
        }
        pipeline = await pipelinePromise;
        setProgress(null);
      } catch (err) {
        pipelinePromise = null; // allow retry on next click
        setState('error');
        setError(
          err instanceof Error
            ? `Failed to load model: ${err.message}`
            : 'Failed to load transcription model'
        );
        return;
      }
    }

    // Request microphone permission
    setState('requesting-permission');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      setState('error');
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setError('Microphone access was denied. Please allow microphone access and try again.');
      } else {
        setError('Could not access microphone.');
      }
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onstop = async () => {
      stopStream();
      const chunks = chunksRef.current;
      chunksRef.current = [];

      if (chunks.length === 0) {
        setState('idle');
        return;
      }

      setState('transcribing');
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const float32 = await resampleTo16kHz(blob);

        const pipe = pipeline as (
          input: Float32Array,
          opts: { sampling_rate: number }
        ) => Promise<{ text: string }>;

        const result = await pipe(float32, { sampling_rate: 16000 });
        const text = result?.text?.trim() ?? '';
        if (text) {
          onTranscriptRef.current(text);
        }
        setState('idle');
      } catch (err) {
        setState('error');
        setError(
          err instanceof Error ? `Transcription failed: ${err.message}` : 'Transcription failed'
        );
      }
    };

    recorder.start();
    setState('recording');
  }, [stopStream]);

  const stopRecording = React.useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
    mediaRecorderRef.current = null;
  }, []);

  const toggleRecording = React.useCallback(() => {
    if (state === 'recording') {
      stopRecording();
    } else if (state === 'idle' || state === 'error') {
      startRecording();
    }
  }, [state, startRecording, stopRecording]);

  // Clean up on unmount
  React.useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      stopStream();
    };
  }, [stopStream]);

  return { state, isSupported, error, progress, toggleRecording };
}
