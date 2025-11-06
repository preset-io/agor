/**
 * OpenCode.ai Client Wrapper
 *
 * Provides a clean TypeScript interface to OpenCode's HTTP-based API.
 * Uses ephemeral HTTP connections - connects when needed, disconnects after.
 * Sessions persist in OpenCode's SQLite database at ~/.opencode/
 *
 * Direct HTTP implementation (no SDK dependency) for simpler integration.
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
 * OpenCode client wrapper with ephemeral HTTP connections
 *
 * Pattern:
 * 1. User runs `opencode serve --port 4096` in a separate terminal
 * 2. Agor connects via ephemeral HTTP requests (no persistent connection)
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
   * Returns the session ID for future reference
   */
  async createSession(params: {
    title: string;
    project: string;
  }): Promise<OpenCodeSession> {
    try {
      const response = await fetch(`${this.config.serverUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: params.title,
          project: params.project,
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
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        }
      );

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
      }

      return String(data || '');
    } catch (error) {
      throw new Error(
        `Failed to send prompt to OpenCode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get message history from a session
   */
  async getMessages(sessionId: string): Promise<any[]> {
    try {
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${sessionId}/messages`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch messages: ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      return Array.isArray(data) ? data : (data.messages || []);
    } catch (error) {
      throw new Error(
        `Failed to fetch messages from OpenCode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Delete a session
   * Called when Agor session is deleted to clean up OpenCode session
   */
  async deleteSession(sessionId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${sessionId}`,
        { method: 'DELETE' }
      );

      if (!response.ok && response.status !== 404) {
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
  async getSessionMetadata(sessionId: string) {
    try {
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${sessionId}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch session metadata: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      throw new Error(
        `Failed to fetch session metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all available sessions in OpenCode
   */
  async listSessions() {
    try {
      const response = await fetch(`${this.config.serverUrl}/api/sessions`);

      if (!response.ok) {
        throw new Error(`Failed to list sessions: ${response.statusText}`);
      }

      const data = (await response.json()) as any;
      return Array.isArray(data) ? data : (data.sessions || []);
    } catch (error) {
      throw new Error(
        `Failed to list OpenCode sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
