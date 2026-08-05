import type {
  ContentBlock,
  ExecutorPulseKind,
  Message,
  MessageID,
  SessionID,
  TaskID,
} from '@agor/core/types';

export interface OpenCodeMessagesService {
  create(data: Partial<Message>): Promise<Message>;
}

export interface OpenCodeStreamingCallbacks {
  onPulse?(kind: ExecutorPulseKind, detail?: string): void;
  onStreamStart(
    messageId: MessageID,
    metadata: { session_id: SessionID; task_id?: TaskID; role: string; timestamp: string }
  ): Promise<void>;
  onStreamChunk(messageId: MessageID, chunk: string, sequence?: number): Promise<void>;
  onStreamEnd(messageId: MessageID): Promise<void>;
  onStreamError(messageId: MessageID, error: Error): Promise<void>;
  onThinkingStart?(messageId: MessageID, metadata: { budget?: number }): Promise<void>;
  onThinkingChunk?(messageId: MessageID, chunk: string): Promise<void>;
  onThinkingEnd?(messageId: MessageID): Promise<void>;
}

export interface OpenCodeToolCapabilities {
  supportsSessionImport: boolean;
  supportsSessionCreate: boolean;
  supportsLiveExecution: boolean;
  supportsSessionFork: boolean;
  supportsChildSpawn: boolean;
  supportsGitState: boolean;
  supportsStreaming: boolean;
}

export interface OpenCodeCreateSessionConfig {
  workingDirectory?: string;
  [key: string]: unknown;
}

export interface OpenCodeSessionHandle {
  sessionId: string;
  toolType: 'opencode';
}

export interface OpenCodeSessionMetadata {
  sessionId: string;
  toolType: 'opencode';
  status: 'active' | 'idle' | 'completed' | 'failed';
  createdAt: Date;
  lastUpdatedAt: Date;
  workingDirectory?: string;
  messageCount?: number;
}

export interface OpenCodeTaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  messages: Message[];
  error?: Error;
  completedAt: Date;
}

export interface OpenCodeRuntimeDependencies {
  getDaemonUrl?: () => Promise<string>;
  enrichContentBlocks?: (blocks: ContentBlock[]) => void;
}
