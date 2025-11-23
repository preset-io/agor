/**
 * Type definitions for executor IPC protocol
 * Based on JSON-RPC 2.0 specification
 */

// Re-export commonly used types from @agor/core for convenience
export type {
  MCPServersConfig,
  Message,
  MessageCreate,
  MessageID,
  PermissionMode,
  SessionID,
  TaskID,
  UserID,
} from '@agor/core/types';
export { MessageRole, TaskStatus } from '@agor/core/types';

// ═══════════════════════════════════════════════════════════
// Base JSON-RPC 2.0 Types
// ═══════════════════════════════════════════════════════════

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

// ═══════════════════════════════════════════════════════════
// Message Handler Types
// ═══════════════════════════════════════════════════════════

export type MessageHandler = (
  message: JSONRPCRequest | JSONRPCNotification,
  respond: ResponseHelper
) => Promise<void>;

export interface ResponseHelper {
  success: (result: unknown) => void;
  error: (code: number, message: string, data?: unknown) => void;
}

// ═══════════════════════════════════════════════════════════
// Ping Handler Types (Phase 1)
// ═══════════════════════════════════════════════════════════

export type PingParams = Record<string, never>;

export interface PingResult {
  pong: true;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════
// Future Handler Types (Phase 2+)
// ═══════════════════════════════════════════════════════════

export interface ExecutePromptParams {
  session_token: string;
  session_id: string;
  task_id: string;
  agentic_tool: string; // 'claude-code' | 'codex' | 'gemini' | 'opencode'
  prompt: string;
  cwd: string;
  tools: string[];
  permission_mode: string;
  timeout_ms: number;
  stream: boolean;
}

export interface ExecutePromptResult {
  status: 'completed' | 'failed' | 'cancelled';
  message_count: number;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
}
