import type { AgorConfig, AgorTelemetrySettings } from '../config/types.js';

export type OpenSourceTelemetryEventName =
  | 'install.completed'
  | 'daemon.start'
  | 'daemon.active'
  | 'daemon.upgraded'
  | 'telemetry.test'
  | 'usage.daily_summary';

export type TelemetryInstallChannel = 'npm' | 'docker' | 'source' | 'homebrew' | 'unknown';
export type TelemetryDeploymentKind = 'local' | 'docker' | 'k8s' | 'unknown';

export type TelemetryProperties = Record<string, unknown>;

export interface OpenSourceTelemetryEvent {
  event: OpenSourceTelemetryEventName;
  properties: TelemetryProperties;
  timestamp?: string;
}

export interface OpenSourceTelemetryTransport {
  send(batch: SegmentBatchPayload): Promise<void>;
}

export interface SegmentTrackPayload {
  type: 'track';
  event: string;
  anonymousId: string;
  properties: TelemetryProperties;
  timestamp: string;
  context?: Record<string, unknown>;
}

export interface SegmentBatchPayload {
  sentAt: string;
  batch: SegmentTrackPayload[];
}

export interface OpenSourceTelemetryLogger {
  isEnabled(): boolean;
  track(event: OpenSourceTelemetryEvent): void;
  flush(): Promise<void>;
}

export interface OpenSourceTelemetryConfig {
  enabled: boolean;
  instanceId: string | null;
  endpoint: string | null;
  writeKey: string | null;
  debug: boolean;
  timeoutMs: number;
  flushIntervalMs: number;
  maxBatchSize: number;
}

export interface ResolveTelemetryConfigOptions {
  env?: NodeJS.ProcessEnv;
  config?: AgorConfig | { telemetry?: AgorTelemetrySettings };
}
