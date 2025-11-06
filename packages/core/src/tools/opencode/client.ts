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
   * Map model name to OpenCode format (providerID + modelID)
   * OpenCode expects: { providerID: "openai", modelID: "gpt-4-turbo" }
   */
  private mapModelToOpenCodeFormat(model: string): { providerID: string; modelID: string } | null {
    // Simple heuristic-based mapping
    if (model.startsWith('gpt-') || model.startsWith('o1-')) {
      return { providerID: 'openai', modelID: model };
    }
    if (model.startsWith('claude-')) {
      return { providerID: 'anthropic', modelID: model };
    }
    if (model.startsWith('gemini-')) {
      return { providerID: 'google', modelID: model };
    }
    if (model.startsWith('llama-') || model.startsWith('mixtral-')) {
      return { providerID: 'together', modelID: model };
    }

    // Default: try with the model name as-is, provider unknown
    console.warn(`[OpenCode] Unknown model format: ${model}, using default provider`);
    return { providerID: 'openai', modelID: model };
  }

  /**
   * Send a prompt to an existing OpenCode session
   * Returns the response as a string
   */
  async sendPrompt(sessionId: string, prompt: string, model?: string): Promise<string> {
    try {
      const requestBody: {
        parts: Array<{ type: string; text: string }>;
        model?: { providerID: string; modelID: string };
      } = {
        parts: [{ type: 'text', text: prompt }],
      };

      // Model parameter - requires API keys configured via `opencode auth login`
      if (model) {
        console.log('[OpenCode] Using model:', model);
        const modelConfig = this.mapModelToOpenCodeFormat(model);
        if (modelConfig) {
          console.log('[OpenCode] Mapped to OpenCode format:', JSON.stringify(modelConfig));
          requestBody.model = modelConfig;
        } else {
          console.warn('[OpenCode] Could not map model to OpenCode format:', model);
        }
      }

      const response = await fetch(`${this.config.serverUrl}/session/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`Failed to send prompt: ${response.statusText}`);
      }

      console.log('[OpenCode] Response status:', response.status);
      console.log('[OpenCode] Response content-length:', response.headers.get('content-length'));

      // Handle empty response body (204 No Content or empty response)
      const contentLength = response.headers.get('content-length');
      if (contentLength === '0' || response.status === 204) {
        // OpenCode accepted the message but returned empty body
        console.error('[OpenCode] Empty response (204 or content-length=0)');
        console.error('[OpenCode] This may indicate missing API keys for the requested model');
        console.error('[OpenCode] Run `opencode auth login` to configure API credentials');
        throw new Error(
          'OpenCode returned empty response - check if API keys are configured for this model'
        );
      }

      let data: unknown;
      try {
        data = await response.json();
        console.log('[OpenCode] Response data:', JSON.stringify(data).substring(0, 200));
      } catch (parseError) {
        // If response body is empty or not JSON, return success message
        const text = await response.text();
        console.log('[OpenCode] Non-JSON response:', text.substring(0, 200));
        if (!text || text.trim() === '') {
          return 'Message sent to OpenCode successfully';
        }
        throw parseError;
      }

      // Extract text from OpenCode response
      // OpenCode returns: { parts: [{ type: 'text', text: '...' }, ...] }
      if (data && typeof data === 'object') {
        // Check for parts array (OpenCode's actual response format)
        if ('parts' in data && Array.isArray(data.parts)) {
          const textParts = (data.parts as Array<{ type?: string; text?: string }>)
            .filter(part => part.type === 'text')
            .map(part => part.text || '')
            .join('\n');
          if (textParts) return textParts;
        }

        // Fallback to other possible fields
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

      // Last resort: stringify the whole object
      return JSON.stringify(data);
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
