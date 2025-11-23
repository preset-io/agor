/**
 * ExecutorIPCServer - Unix socket server for executor process
 * Receives JSON-RPC requests from daemon, sends notifications back
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import type {
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  MessageHandler,
  ResponseHelper,
} from './types.js';

export class ExecutorIPCServer extends EventEmitter {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<
    string | number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(
    private socketPath: string,
    private messageHandler: MessageHandler
  ) {
    super();
  }

  /**
   * Start the Unix socket server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }

      this.server = net.createServer((socket) => {
        console.log('[executor] Daemon connected');
        this.client = socket;

        socket.on('data', (chunk) => {
          console.log(
            `[executor] Received data from daemon: ${chunk.toString().substring(0, 100)}...`
          );
          this.handleIncomingData(chunk, socket);
        });

        socket.on('close', () => {
          console.log('[executor] Daemon disconnected');
          this.client = null;
        });

        socket.on('error', (error) => {
          console.error('[executor] Client socket error:', error);
        });
      });

      this.server.listen(this.socketPath, () => {
        console.log(`[executor] IPC server listening on ${this.socketPath}`);

        // Set socket permissions so daemon can connect
        // Socket needs to be readable/writable by both executor user and daemon user
        try {
          fs.chmodSync(this.socketPath, 0o666); // rw-rw-rw-
          console.log(`[executor] Socket permissions set to 0666`);
        } catch (err) {
          console.error(`[executor] Failed to set socket permissions:`, err);
        }

        resolve();
      });

      this.server.on('error', (error) => {
        console.error('[executor] Server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Handle incoming data from daemon (newline-delimited JSON)
   */
  private handleIncomingData(chunk: Buffer, socket: net.Socket): void {
    this.buffer += chunk.toString();
    console.log(`[executor] Buffer now has ${this.buffer.length} chars, looking for newlines...`);

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        console.log(`[executor] Processing message (${line.length} chars)`);

        try {
          const message = JSON.parse(line);
          console.log(
            `[executor] Parsed JSON, has 'id': ${'id' in message}, has 'method': ${'method' in message}`
          );

          // Check if it's a response to our request
          if ('id' in message && !('method' in message) && this.pendingRequests.has(message.id)) {
            console.log(`[executor] This is a RESPONSE to our request id: ${message.id}`);
            this.handleResponse(message as JSONRPCResponse);
          } else {
            // It's a request/notification from daemon
            console.log(`[executor] This is a REQUEST/NOTIFICATION from daemon`);
            this.handleMessage(message, socket);
          }
        } catch (error) {
          console.error('[executor] Failed to parse message:', error);
        }
      }

      // Check for next newline
      newlineIndex = this.buffer.indexOf('\n');
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
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private async handleMessage(message: unknown, socket: net.Socket): Promise<void> {
    const msg = message as JSONRPCRequest | JSONRPCNotification;

    console.log(`[executor] Received: ${msg.method}`);

    // Check if it's a request (has id) or notification (no id)
    const isRequest = 'id' in msg;

    // Create response helper
    const respond: ResponseHelper = {
      success: (result: unknown) => {
        if (!isRequest) {
          console.warn('[executor] Cannot respond to notification');
          return;
        }

        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: msg.id,
          result,
        };

        console.log(`[executor] Sending success response for: ${msg.method}`);
        socket.write(`${JSON.stringify(response)}\n`);
      },

      error: (code: number, message: string, data?: unknown) => {
        if (!isRequest) {
          console.warn('[executor] Cannot send error for notification');
          return;
        }

        console.log(`[executor] Sending error response for: ${msg.method} (${message})`);

        const response: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code, message, data },
        };

        socket.write(`${JSON.stringify(response)}\n`);
      },
    };

    // Emit notification events for listeners (e.g., permission_resolved)
    if (!isRequest) {
      this.emit(msg.method, msg.params);
    }

    // Call message handler
    try {
      await this.messageHandler(msg, respond);
    } catch (error) {
      const err = error as Error;
      console.error('[executor] Message handler error:', err);

      if (isRequest) {
        respond.error(-32603, err.message || 'Internal error', {
          stack: err.stack,
        });
      }
    }
  }

  /**
   * Send notification to daemon (fire-and-forget)
   */
  notify(method: string, params: unknown): void {
    if (!this.client) {
      throw new Error('No client connected');
    }

    const notification: JSONRPCNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.client.write(`${JSON.stringify(notification)}\n`);
  }

  /**
   * Send request to daemon and wait for response
   */
  async request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    if (!this.client) {
      throw new Error('No client connected');
    }

    return new Promise((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random()}`;

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

      if (!this.client) {
        reject(new Error('Not connected'));
        return;
      }

      this.client.write(`${JSON.stringify(request)}\n`);
    });
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server stopped'));
    }
    this.pendingRequests.clear();

    return new Promise((resolve) => {
      if (this.client) {
        this.client.end();
      }

      if (this.server) {
        this.server.close(() => {
          // Clean up socket file
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
