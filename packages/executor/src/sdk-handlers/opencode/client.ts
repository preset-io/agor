/**
 * OpenCode.ai Client Wrapper
 *
 * Uses official @opencode-ai/sdk for TypeScript client
 * Sessions persist in OpenCode's SQLite database at ~/.opencode/
 *
 * Migration from raw fetch to official SDK for:
 * - Better TypeScript types
 * - Built-in error handling
 * - Streaming support
 * - Automatic retries and timeouts
 */

import { createOpencodeClient, type Session, type StepFinishPart } from '@opencode-ai/sdk';

export interface OpenCodeConfig {
  serverUrl: string;
  timeout?: number;
}

// Re-export SDK Session type for convenience
export type { Session as OpenCodeSession };

export interface OpenCodeMessageEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'error';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

// Response metadata extracted from StepFinishPart
export interface OpenCodeResponseMetadata {
  messageId?: string;
  parentMessageId?: string;
  cost?: number;
  tokens?: StepFinishPart['tokens'];
}

export interface OpenCodePromptResponse {
  text: string;
  metadata?: OpenCodeResponseMetadata;
}

/**
 * OpenCode client using official SDK
 *
 * Pattern:
 * 1. User runs `opencode serve --port 4096` in a separate terminal
 * 2. Agor connects via SDK client
 * 3. Sessions persist in OpenCode's SQLite at ~/.opencode/
 * 4. Map Agor session IDs → OpenCode session IDs
 */
export class OpenCodeClient {
  private client: ReturnType<typeof createOpencodeClient>;

  constructor(config: OpenCodeConfig) {
    this.client = createOpencodeClient({
      baseUrl: config.serverUrl,
      // Note: SDK doesn't support timeout in constructor, will handle via request options if needed
    });
  }

  /**
   * Check if OpenCode server is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Try to list sessions as health check
      await this.client.session.list();
      return true;
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
  }): Promise<Session> {
    try {
      // Note: OpenCode SDK session.create doesn't support model parameter
      // Model is specified per-message in prompt() calls
      console.log('[OpenCode SDK] Creating session:', { title: params.title });

      const response = await this.client.session.create({
        body: {
          title: params.title,
        },
      });

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      // Return the SDK Session object directly
      return response.data;
    } catch (error) {
      throw new Error(
        `Failed to create OpenCode session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Send a prompt to an existing OpenCode session
   * Returns the response text and metadata
   *
   * @param sessionId - OpenCode session ID
   * @param prompt - User prompt
   * @param model - Model identifier (modelID)
   * @param provider - Optional provider ID (providerID)
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    model?: string,
    provider?: string
  ): Promise<OpenCodePromptResponse> {
    try {
      const promptOptions: {
        path: { id: string };
        body: {
          parts: Array<{ type: 'text'; text: string }>;
          model?: { providerID: string; modelID: string };
        };
      } = {
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: prompt }],
        },
      };

      // Include model if provided
      if (model && provider) {
        console.log(
          '[OpenCode SDK] Sending prompt with model:',
          JSON.stringify({ providerID: provider, modelID: model })
        );
        promptOptions.body.model = { providerID: provider, modelID: model };
      }

      const response = await this.client.session.prompt(promptOptions);

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      console.log('[OpenCode SDK] Response received');

      // Extract text and metadata from response
      let text = '';
      const metadata: OpenCodeResponseMetadata = {};

      // Extract metadata from 'info' field
      if (response.data.info) {
        if (response.data.info.id) {
          metadata.messageId = response.data.info.id;
        }
        if (response.data.info.parentID) {
          metadata.parentMessageId = response.data.info.parentID;
        }
      }

      // Extract text and token/cost metadata from 'parts' array
      if (response.data.parts && Array.isArray(response.data.parts)) {
        // Extract text parts
        const textParts = response.data.parts
          .filter((part) => part.type === 'text' && 'text' in part && typeof part.text === 'string')
          .map((part) => {
            if (part.type === 'text') {
              return part.text;
            }
            return '';
          });
        text = textParts.join('\n');

        // Extract metadata from step-finish part
        const stepFinish = response.data.parts.find((part) => part.type === 'step-finish');
        if (stepFinish && stepFinish.type === 'step-finish') {
          metadata.cost = stepFinish.cost;
          metadata.tokens = {
            input: stepFinish.tokens.input,
            output: stepFinish.tokens.output,
            reasoning: stepFinish.tokens.reasoning,
            cache: {
              read: stepFinish.tokens.cache.read,
              write: stepFinish.tokens.cache.write,
            },
          };
        }
      }

      // Fallback: if no text found, return empty
      if (!text) {
        text = 'No response text received from OpenCode';
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
      const response = await this.client.session.messages({
        path: { id: sessionId },
      });

      if (response.error) {
        console.error('Failed to get messages:', response.error);
        return [];
      }

      return Array.isArray(response.data) ? response.data : [];
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
      const response = await this.client.session.delete({
        path: { id: sessionId },
      });

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
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
  async getSessionMetadata(sessionId: string): Promise<Session> {
    try {
      const response = await this.client.session.get({
        path: { id: sessionId },
      });

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      // Return the SDK Session object directly
      return response.data;
    } catch (error) {
      throw new Error(
        `Failed to get session metadata: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all sessions
   */
  async listSessions(): Promise<Session[]> {
    try {
      const response = await this.client.session.list();

      if (response.error) {
        throw new Error(`OpenCode API error: ${JSON.stringify(response.error)}`);
      }

      // Return the SDK Session array directly
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      throw new Error(
        `Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
