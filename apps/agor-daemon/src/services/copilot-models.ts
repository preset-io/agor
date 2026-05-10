/**
 * Copilot Models Service
 *
 * Exposes `client.listModels()` from @github/copilot-sdk as a Feathers
 * endpoint so the UI's model picker can render the live list (which respects
 * BYOK provider keys, account policies, etc.) instead of just the static
 * fallback baked into @agor/core/models/copilot.ts.
 *
 * Design notes:
 *
 *   - **No cache, no warm client.** Each request spawns a fresh
 *     `CopilotClient`, calls `listModels()`, and stops it. The picker is a
 *     rare interactive event — paying ~1-2s of subprocess spawn per call is
 *     acceptable, especially since the UI shows the static fallback
 *     immediately and upgrades when the dynamic list arrives. Avoiding
 *     persistent state also eliminates the cross-tenant cache-keying bug
 *     class.
 *   - **Per-user token resolution** via `resolveApiKey` — picks up the
 *     calling user's `data.agentic_tools.copilot.COPILOT_GITHUB_TOKEN` first,
 *     then falls back to config.yaml, then `process.env`. Each user sees
 *     their own account's BYOK lineup; no leakage between users.
 *   - **Static fallback on any failure.** No token, decrypt failure, SDK
 *     throws, CLI binary missing — all degrade silently to the static list
 *     the UI already has bundled. The picker stays usable.
 */

import { resolveApiKey } from '@agor/core/config';
import type { Database } from '@agor/core/db';
import { COPILOT_MODEL_METADATA, DEFAULT_COPILOT_MODEL } from '@agor/core/models';
import type { Params, UserID } from '@agor/core/types';
import { CopilotClient, type ModelInfo } from '@github/copilot-sdk';

export interface CopilotModelOption {
  id: string;
  displayName: string;
  description?: string;
  provider?: string;
  /** Whether the model came from `listModels()` or the static fallback */
  source: 'dynamic' | 'static';
}

export interface CopilotModelsResult {
  default: string;
  models: CopilotModelOption[];
  /**
   * 'dynamic' if the list came from listModels(); 'static' if we fell back.
   * Useful for the UI to label the picker honestly.
   */
  source: 'dynamic' | 'static';
}

const STATIC_MODELS: CopilotModelOption[] = Object.entries(COPILOT_MODEL_METADATA).map(
  ([id, meta]) => ({
    id,
    displayName: meta.name,
    description: meta.description,
    provider: meta.provider,
    source: 'static',
  })
);

const STATIC_RESULT: CopilotModelsResult = {
  default: DEFAULT_COPILOT_MODEL,
  models: STATIC_MODELS,
  source: 'static',
};

interface AuthenticatedParams extends Params {
  user?: { user_id: UserID };
}

export class CopilotModelsService {
  constructor(private db: Database) {}

  async find(params?: AuthenticatedParams): Promise<CopilotModelsResult> {
    const userId = params?.user?.user_id;

    // Resolve the GitHub token. Precedence: per-user > config.yaml > env.
    // Falls through to static if nothing is configured anywhere.
    const resolution = await resolveApiKey('COPILOT_GITHUB_TOKEN', {
      userId,
      db: this.db,
      tool: 'copilot',
    });

    if (!resolution.apiKey) {
      console.log(
        `[Copilot Models] No GitHub token for user ${userId?.substring(0, 8) ?? 'unknown'} — returning static list`
      );
      return STATIC_RESULT;
    }

    let client: CopilotClient | undefined;
    try {
      client = new CopilotClient({
        useStdio: true,
        githubToken: resolution.apiKey,
        env: { HOME: process.env.HOME || '' },
      });
      await client.start();
      const dynamic: ModelInfo[] = await client.listModels();
      console.log(
        `[Copilot Models] Fetched ${dynamic.length} models for user ${userId?.substring(0, 8) ?? 'unknown'} (source: ${resolution.source})`
      );
      return {
        default: DEFAULT_COPILOT_MODEL,
        models: dynamic.map((m) => ({
          id: m.id,
          displayName: m.name,
          source: 'dynamic',
        })),
        source: 'dynamic',
      };
    } catch (err) {
      console.warn(
        '[Copilot Models] listModels() failed, falling back to static list:',
        err instanceof Error ? err.message : err
      );
      return STATIC_RESULT;
    } finally {
      // Always tear down the subprocess. SDK's `stop()` returns errors
      // rather than throwing, so we just log them.
      if (client) {
        try {
          const errors = await client.stop();
          if (errors.length > 0) {
            console.warn('[Copilot Models] Errors during client.stop():', errors);
          }
        } catch (err) {
          console.warn('[Copilot Models] client.stop() threw:', err);
        }
      }
    }
  }
}

export function createCopilotModelsService(db: Database): CopilotModelsService {
  return new CopilotModelsService(db);
}
