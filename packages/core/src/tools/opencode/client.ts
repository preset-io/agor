/**
 * OpenCode.ai Client Wrapper
 *
 * Direct HTTP client for OpenCode server API.
 * Uses ephemeral HTTP connections - connects when needed, disconnects after.
 * Sessions persist in OpenCode's SQLite database at ~/.opencode/
 *
 * OpenCode server exposes REST API at baseUrl/api/*
 */

export interface OpenCodeConfig {
  serverUrl: string;
  timeout?: number;
}

export interface OpenCodeSession {
  id: string;
  title: string;
  project: string;
  createdAt: string;
}

export interface OpenCodeMessageEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'error';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

/**
 * OpenCode client with direct HTTP calls
 *
 * Pattern:
 * 1. User runs `opencode serve --port 4096` in a separate terminal
 * 2. Agor connects via ephemeral HTTP requests
 * 3. Sessions persist in OpenCode's SQLite at ~/.opencode/
 * 4. Map Agor session IDs → OpenCode session IDs
 */
export class OpenCodeClient {
  private config: OpenCodeConfig;

  constructor(config: OpenCodeConfig) {
    this.config = config;
  }

  /**
   * Check if OpenCode server is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);
      try {
        const response = await fetch(`${this.config.serverUrl}/health`, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response.ok;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    } catch {
      return false;
    }
  }

  /**
   * Create a new OpenCode session
   */
  async createSession(params: { title: string; project: string }): Promise<OpenCodeSession> {
    try {
      const response = await fetch(`${this.config.serverUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: params.title,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.statusText}`);
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        id: String(data.id || ''),
        title: String(data.title || params.title),
        project: params.project,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(
        `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Send a prompt to an existing OpenCode session
   * Returns the response as a string
   */
  async sendPrompt(sessionId: string, prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.config.serverUrl}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to send prompt: ${response.statusText}`);
      }

      const data = await response.json();

      // Extract text from response
      if (data && typeof data === 'object') {
        if ('output' in data) {
          return String(data.output);
        }
        if ('text' in data) {
          return String(data.text);
        }
        if ('content' in data) {
          return String(data.content);
        }
        if ('message' in data) {
          return String(data.message);
        }
        if ('response' in data) {
          return String(data.response);
        }
      }

      return String(data || '');
    } catch (error) {
      throw new Error(
        `Failed to send prompt to OpenCode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get messages from a session
   */
  async getMessages(sessionId: string): Promise<Record<string, unknown>[]> {
    try {
      const response = await fetch(`${this.config.serverUrl}/session/${sessionId}/message`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      if (Array.isArray(data)) {
        return data;
      }

      return [];
    } catch (error) {
      console.error('Failed to get messages:', error);
      return [];
    }
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const response = await fetch(`${this.config.serverUrl}/session/${sessionId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error(`Failed to delete session: ${response.statusText}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to delete OpenCode session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get session metadata
   */
  async getSessionMetadata(
    sessionId: string
  ): Promise<{ id: string; title: string; createdAt?: string }> {
    try {
      const response = await fetch(`${this.config.serverUrl}/session/${sessionId}`, {
        method: 'GET',
      });

      if (!response.ok) {
        throw new Error('Failed to get session');
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        id: String(data.id || sessionId),
        title: String(data.title || 'Untitled'),
        createdAt: String(data.createdAt || new Date().toISOString()),
      };
    } catch (error) {
      throw new Error(
        `Failed to get session metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<OpenCodeSession[]> {
    try {
      const response = await fetch(`${this.config.serverUrl}/session`, {
        method: 'GET',
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();

      if (Array.isArray(data)) {
        return data.map((s: Record<string, unknown>) => ({
          id: String(s.id || ''),
          title: String(s.title || 'Untitled'),
          project: String(s.project || ''),
          createdAt: String(s.createdAt || new Date().toISOString()),
        }));
      }

      return [];
    } catch (error) {
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
