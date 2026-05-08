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
 *   - Lazy-init a single `CopilotClient` on first request and keep it warm
 *     for the lifetime of the daemon. Spawning the underlying CLI binary on
 *     every UI mount would be wasteful — and the SDK already caches per
 *     connection.
 *   - We layer a daemon-side TTL on top so we don't pay even the round-trip
 *     cost on repeated picker opens.
 *   - On *any* failure (no token, SDK throws, CLI binary missing, timeout)
 *     we log and return the static fallback. The picker stays usable.
 *   - Auth: today we use the daemon-level `process.env.COPILOT_GITHUB_TOKEN`
 *     (loaded from config.yaml or env at startup). Per-user BYOK / token
 *     scoping is a follow-up — see context/explorations and the per-tool
 *     credential scoping work.
 */

import { COPILOT_MODEL_METADATA, DEFAULT_COPILOT_MODEL } from '@agor/core/models';
import type { Params } from '@agor/core/types';
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
   * 'dynamic' if every model came from listModels(); 'static' if we fell
   * back. Useful for the UI to label the picker honestly.
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

/** Cache TTL for the dynamic list. SDK caches per-connection; this is on top. */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class CopilotModelsService {
  private client?: CopilotClient;
  private cache?: { result: CopilotModelsResult; expiresAt: number };

  async find(_params?: Params): Promise<CopilotModelsResult> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.result;
    }

    const token =
      process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
      console.log('[Copilot Models] No GitHub token configured — returning static list');
      return STATIC_RESULT;
    }

    try {
      if (!this.client) {
        this.client = new CopilotClient({
          useStdio: true,
          githubToken: token,
          env: { HOME: process.env.HOME || '' },
        });
        await this.client.start();
      }

      const dynamic: ModelInfo[] = await this.client.listModels();
      const result: CopilotModelsResult = {
        default: DEFAULT_COPILOT_MODEL,
        models: dynamic.map((m) => ({
          id: m.id,
          displayName: m.name,
          source: 'dynamic',
        })),
        source: 'dynamic',
      };
      this.cache = { result, expiresAt: now + CACHE_TTL_MS };
      return result;
    } catch (err) {
      console.warn(
        '[Copilot Models] listModels() failed, falling back to static list:',
        err instanceof Error ? err.message : err
      );
      return STATIC_RESULT;
    }
  }
}

export function createCopilotModelsService(): CopilotModelsService {
  return new CopilotModelsService();
}
