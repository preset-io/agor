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

export interface OpenCodeResponseMetadata {
  messageId?: string;
  parentMessageId?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
}

export interface OpenCodePromptResponse {
  text: string;
  metadata?: OpenCodeResponseMetadata;
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
  async createSession(params: {
    title: string;
    project: string;
    model?: string;
    provider?: string;
  }): Promise<OpenCodeSession> {
    try {
      const requestBody: {
        title: string;
        model?: { providerID: string; modelID: string };
      } = {
        title: params.title,
      };

      // Include model if provided
      if (params.model) {
        // If provider is explicitly provided, use it directly
        if (params.provider) {
          console.log(
            '[OpenCode] Creating session with explicit provider:',
            JSON.stringify({ providerID: params.provider, modelID: params.model })
          );
          requestBody.model = { providerID: params.provider, modelID: params.model };
        } else {
          // Fallback to mapping for backwards compatibility
          const modelConfig = this.mapModelToOpenCodeFormat(params.model);
          if (modelConfig) {
            console.log('[OpenCode] Creating session with model:', JSON.stringify(modelConfig));
            requestBody.model = modelConfig;
          }
        }
      }

      const response = await fetch(`${this.config.serverUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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
   *
   * Note: OpenCode Zen provides access to multiple models via providerID: "opencode"
   * This includes Claude models if you have Zen credits but no direct Anthropic API key
   */
  private mapModelToOpenCodeFormat(model: string): { providerID: string; modelID: string } | null {
    // OpenAI models - use direct OpenAI provider if you have API key
    if (model.startsWith('gpt-') || model.startsWith('o1-')) {
      return { providerID: 'openai', modelID: model };
    }

    // Claude models - check if it's an OpenCode Zen model first
    if (model.startsWith('claude-')) {
      // Map Agor's Claude model names to OpenCode Zen model IDs
      // OpenCode Zen models: claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1, claude-3-5-haiku
      const zenModelMap: Record<string, string> = {
        'claude-sonnet-4-5': 'claude-sonnet-4-5',
        'claude-3-7-sonnet': 'claude-sonnet-4-5', // Alias
        'claude-3-5-sonnet': 'claude-3-5-haiku', // Fallback to 3.5 haiku
        'claude-3-5-sonnet-20241022': 'claude-3-5-haiku',
        'claude-3-5-haiku': 'claude-3-5-haiku',
        'claude-haiku-4-5': 'claude-haiku-4-5',
        'claude-opus-4-1': 'claude-opus-4-1',
      };

      const zenModelId = zenModelMap[model];
      if (zenModelId) {
        console.log(`[OpenCode] Mapping ${model} to OpenCode Zen model: ${zenModelId}`);
        return { providerID: 'opencode', modelID: zenModelId };
      }

      // Fallback to direct Anthropic provider (requires Anthropic API key)
      console.warn(`[OpenCode] Unknown Claude model ${model}, trying direct Anthropic provider`);
      return { providerID: 'anthropic', modelID: model };
    }

    // Gemini models
    if (model.startsWith('gemini-')) {
      return { providerID: 'google', modelID: model };
    }

    // Together.ai models
    if (model.startsWith('llama-') || model.startsWith('mixtral-')) {
      return { providerID: 'together', modelID: model };
    }

    // Default: try with OpenCode Zen provider
    console.warn(`[OpenCode] Unknown model format: ${model}, trying OpenCode Zen provider`);
    return { providerID: 'opencode', modelID: model };
  }

  /**
   * Send a prompt to an existing OpenCode session
   * Returns the response text and metadata
   *
   * @param sessionId - OpenCode session ID
   * @param prompt - User prompt
   * @param model - Model identifier (modelID)
   * @param provider - Optional provider ID (providerID) - if provided, uses explicit provider:model, otherwise maps model name
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    model?: string,
    provider?: string
  ): Promise<OpenCodePromptResponse> {
    try {
      const requestBody: {
        parts: Array<{ type: string; text: string }>;
        model?: { providerID: string; modelID: string };
      } = {
        parts: [{ type: 'text', text: prompt }],
      };

      // Model parameter - requires API keys configured via `opencode auth login`
      if (model) {
        console.log('[OpenCode] Using model:', model, 'provider:', provider);

        // If provider is explicitly provided, use it directly (from UI dropdown)
        if (provider) {
          console.log(
            '[OpenCode] Using explicit provider:',
            JSON.stringify({ providerID: provider, modelID: model })
          );
          requestBody.model = { providerID: provider, modelID: model };
        } else {
          // Fallback to mapping for backwards compatibility (old sessions without provider)
          const modelConfig = this.mapModelToOpenCodeFormat(model);
          if (modelConfig) {
            console.log('[OpenCode] Mapped to OpenCode format:', JSON.stringify(modelConfig));
            requestBody.model = modelConfig;
          } else {
            console.warn('[OpenCode] Could not map model to OpenCode format:', model);
          }
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
        // Log summary instead of full response to avoid log truncation
        console.log(
          '[OpenCode] Response received (keys):',
          data && typeof data === 'object' ? Object.keys(data) : typeof data
        );
      } catch (parseError) {
        // If response body is empty or not JSON, return success message
        const text = await response.text();
        console.log('[OpenCode] Non-JSON response:', text.substring(0, 200));
        if (!text || text.trim() === '') {
          return { text: 'Message sent to OpenCode successfully' };
        }
        throw parseError;
      }

      // Extract text and metadata from OpenCode response
      // OpenCode returns: { info: {...}, parts: [...], blocked: bool, shouldRetry: bool }
      let text = '';
      const metadata: OpenCodeResponseMetadata = {};

      if (data && typeof data === 'object') {
        // Extract metadata from 'info' field
        if ('info' in data && data.info && typeof data.info === 'object') {
          const info = data.info as Record<string, unknown>;
          if ('id' in info && typeof info.id === 'string') {
            metadata.messageId = info.id;
          }
          if ('parentID' in info && typeof info.parentID === 'string') {
            metadata.parentMessageId = info.parentID;
          }
        }

        // Extract text and token/cost metadata from 'parts' array
        if ('parts' in data && Array.isArray(data.parts)) {
          const parts = data.parts as Array<Record<string, unknown>>;

          // Extract text parts
          const textParts = parts
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text as string);
          text = textParts.join('\n');

          // Extract metadata from step-finish part
          const stepFinish = parts.find((part) => part.type === 'step-finish');
          if (stepFinish) {
            if (typeof stepFinish.cost === 'number') {
              metadata.cost = stepFinish.cost;
            }
            if (stepFinish.tokens && typeof stepFinish.tokens === 'object') {
              const tokens = stepFinish.tokens as Record<string, unknown>;
              metadata.tokens = {
                input: typeof tokens.input === 'number' ? tokens.input : undefined,
                output: typeof tokens.output === 'number' ? tokens.output : undefined,
                reasoning: typeof tokens.reasoning === 'number' ? tokens.reasoning : undefined,
              };
              if (tokens.cache && typeof tokens.cache === 'object') {
                const cache = tokens.cache as Record<string, unknown>;
                metadata.tokens.cache = {
                  read: typeof cache.read === 'number' ? cache.read : undefined,
                  write: typeof cache.write === 'number' ? cache.write : undefined,
                };
              }
            }
          }
        }

        // Fallback: try other possible text fields if no text found in parts
        if (!text) {
          if ('output' in data && typeof data.output === 'string') {
            text = data.output;
          } else if ('text' in data && typeof data.text === 'string') {
            text = data.text;
          } else if ('content' in data && typeof data.content === 'string') {
            text = data.content;
          } else if ('message' in data && typeof data.message === 'string') {
            text = data.message;
          } else if ('response' in data && typeof data.response === 'string') {
            text = data.response;
          }
        }
      }

      // If still no text, last resort: stringify the whole object
      if (!text) {
        text = JSON.stringify(data);
      }

      return { text, metadata };
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
