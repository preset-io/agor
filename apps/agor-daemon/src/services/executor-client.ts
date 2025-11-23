/**
 * ExecutorClient - Daemon-side IPC client for communicating with executor
 * Connects to executor's Unix socket and sends/receives JSON-RPC messages
 */

import { randomUUID } from 'node:crypto';
import * as net from 'node:net';

// JSON-RPC 2.0 types
interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type NotificationHandler = (params: unknown) => void | Promise<void>;
type RequestHandler = (params: unknown) => Promise<unknown>;

export class ExecutorClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private requestHandlers = new Map<string, RequestHandler>();
  private connected = false;

  constructor(private socketPath: string) {}

  /**
   * Connect to executor's Unix socket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.socketPath);

      this.socket.on('connect', () => {
        console.log(`[daemon] Connected to executor at ${this.socketPath}`);
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (chunk) => {
        this.handleIncomingData(chunk);
      });

      this.socket.on('error', (error) => {
        console.error('[daemon] Executor socket error:', error);
        reject(error);
      });

      this.socket.on('close', () => {
        console.log('[daemon] Executor disconnected');
        this.connected = false;
        this.cleanup();
      });
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.socket?.readyState === 'open';
  }

  /**
   * Handle incoming data (newline-delimited JSON)
   */
  private handleIncomingData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (error) {
          console.error('[daemon] Failed to parse message from executor:', error);
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: unknown): void {
    const msg = message as JSONRPCRequest | JSONRPCResponse | JSONRPCNotification;

    // Check if it's a response to our request
    if ('id' in msg && !('method' in msg)) {
      this.handleResponse(msg as JSONRPCResponse);
    }
    // Check if it's a notification from executor
    else if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg as JSONRPCNotification);
    }
    // Otherwise it's a request from executor
    else if ('method' in msg && 'id' in msg) {
      this.handleIncomingRequest(msg as JSONRPCRequest);
    } else {
      console.warn('[daemon] Unexpected message type from executor:', msg);
    }
  }

  /**
   * Handle response to our request
   */
  private handleResponse(response: JSONRPCResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.id);

      if (response.error) {
        console.log(`[daemon] Received error response: ${response.error.message}`);
        pending.reject(new Error(response.error.message));
      } else {
        console.log(`[daemon] Received success response (result type: ${typeof response.result})`);
        pending.resolve(response.result);
      }
    } else {
      console.warn(`[daemon] Received response for unknown request ID: ${response.id}`);
    }
  }

  /**
   * Handle notification from executor
   */
  private handleNotification(notification: JSONRPCNotification): void {
    console.log(`[daemon] Received notification from executor: ${notification.method}`);
    const handler = this.notificationHandlers.get(notification.method);
    if (handler) {
      try {
        handler(notification.params);
      } catch (error) {
        console.error(`[daemon] Notification handler error for ${notification.method}:`, error);
      }
    } else {
      console.warn(`[daemon] No handler for notification: ${notification.method}`);
    }
  }

  /**
   * Handle incoming request from executor
   */
  private async handleIncomingRequest(request: JSONRPCRequest): Promise<void> {
    const handler = this.requestHandlers.get(request.method);

    if (!handler) {
      this.sendErrorResponse(request.id, -32601, `Unknown method: ${request.method}`);
      return;
    }

    try {
      const result = await handler(request.params);
      console.log(
        `[daemon] Handler succeeded for ${request.method}, sending success response to executor`
      );
      this.sendSuccessResponse(request.id, result);
    } catch (error) {
      const err = error as Error;
      console.error(`[daemon] Request handler error for ${request.method}:`, err);
      console.log(`[daemon] Sending error response to executor for ${request.method}`);
      this.sendErrorResponse(request.id, -32000, err.message || 'Handler error', {
        stack: err.stack,
      });
    }
  }

  /**
   * Send success response to executor
   */
  private sendSuccessResponse(id: string | number, result: unknown): void {
    if (!this.socket) {
      console.warn('[daemon] Cannot send success response: socket not connected');
      return;
    }

    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };

    const responseStr = JSON.stringify(response);
    console.log(
      `[daemon] Writing success response to socket (id: ${id}, length: ${responseStr.length})`
    );
    const written = this.socket.write(`${responseStr}\n`);
    console.log(`[daemon] Socket write returned: ${written}`);
  }

  /**
   * Send error response to executor
   */
  private sendErrorResponse(
    id: string | number,
    code: number,
    message: string,
    data?: unknown
  ): void {
    if (!this.socket) {
      return;
    }

    const response: JSONRPCResponse = {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    };

    this.socket.write(`${JSON.stringify(response)}\n`);
  }

  /**
   * Send a request and wait for response
   */
  async request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.socket) {
      throw new Error('Not connected to executor');
    }

    console.log(`[daemon] Sending request to executor: ${method}`);

    return new Promise((resolve, reject) => {
      const id = randomUUID();

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const request: JSONRPCRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.socket!.write(`${JSON.stringify(request)}\n`);
    });
  }

  /**
   * Send a notification (fire-and-forget)
   */
  notify(method: string, params: unknown): void {
    if (!this.socket) {
      throw new Error('Not connected to executor');
    }

    const notification: JSONRPCNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.socket.write(`${JSON.stringify(notification)}\n`);
  }

  /**
   * Register handler for notifications from executor
   */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Remove notification handler
   */
  offNotification(method: string): void {
    this.notificationHandlers.delete(method);
  }

  /**
   * Register handler for requests from executor
   */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /**
   * Remove request handler
   */
  offRequest(method: string): void {
    this.requestHandlers.delete(method);
  }

  /**
   * Disconnect from executor
   */
  async disconnect(): Promise<void> {
    this.cleanup();

    if (this.socket) {
      return new Promise((resolve) => {
        this.socket!.end(() => {
          this.socket = null;
          resolve();
        });
      });
    }
  }

  /**
   * Cleanup on disconnect
   */
  private cleanup(): void {
    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }
}
