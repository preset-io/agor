/**
 * Claude Models Service
 *
 * Exposes the Anthropic Models API (`models.list()`) as a Feathers endpoint so
 * the UI can render the live model list. Falls back to the static
 * AVAILABLE_CLAUDE_MODEL_ALIASES when no API key is configured or the call fails.
 */

import { resolveApiKey } from '@agor/core/config';
import { type Database, shortId } from '@agor/core/db';
import { AVAILABLE_CLAUDE_MODEL_ALIASES, DEFAULT_CLAUDE_MODEL } from '@agor/core/models';
import type { Params, UserID } from '@agor/core/types';
import Anthropic from '@anthropic-ai/sdk';

export interface ClaudeModelOption {
  id: string;
  displayName: string;
  description?: string;
  source: 'dynamic' | 'static';
}

export interface ClaudeModelsResult {
  default: string;
  models: ClaudeModelOption[];
  source: 'dynamic' | 'static';
}

const CLAUDE_MODELS_TIMEOUT_MS = 8_000;

const STATIC_RESULT: ClaudeModelsResult = {
  default: DEFAULT_CLAUDE_MODEL,
  models: AVAILABLE_CLAUDE_MODEL_ALIASES.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    source: 'static' as const,
  })),
  source: 'static',
};

interface AuthenticatedParams extends Params {
  user?: { user_id: UserID };
}

/**
 * Dated snapshot IDs (e.g. claude-sonnet-4-6-20260514) are noise in a picker
 * that already has the alias form. Keep only alias-style entries.
 */
function isAlias(id: string): boolean {
  return /^claude-[a-z]+-\d+-\d+$/.test(id);
}

const CONTEXT_1M_BETA = 'context-1m-2025-08-07';
const ONE_MILLION_TOKENS = 900_000; // threshold to detect 1M-eligible models

/**
 * Build the option list from the API response. Models whose
 * `max_input_tokens` >= 900k (when fetched with the 1M beta flag) get a
 * `[1m]` variant — no static allowlist required.
 */
function toModelOptions(models: Anthropic.ModelInfo[]): ClaudeModelOption[] {
  const aliases = models.filter((m) => isAlias(m.id));

  const options: ClaudeModelOption[] = [];
  for (const m of aliases) {
    options.push({
      id: m.id,
      displayName: m.display_name,
      description: undefined,
      source: 'dynamic',
    });
    if (m.max_input_tokens && m.max_input_tokens >= ONE_MILLION_TOKENS) {
      options.push({
        id: `${m.id}[1m]`,
        displayName: `${m.display_name} (1M context)`,
        description: `${m.display_name} with extended 1M token context window`,
        source: 'dynamic',
      });
    }
  }
  return options;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ClaudeModelsService {
  constructor(private db: Database) {}

  async find(params?: AuthenticatedParams): Promise<ClaudeModelsResult> {
    const userId = params?.user?.user_id;
    const resolution = await resolveApiKey('ANTHROPIC_API_KEY', {
      userId,
      db: this.db,
      tool: 'claude-code',
    });

    if (!resolution.apiKey) {
      console.log(
        `[Claude Models] No Anthropic API key for user ${userId ? shortId(userId) : 'unknown'} — returning static list`
      );
      return STATIC_RESULT;
    }

    try {
      const client = new Anthropic({ apiKey: resolution.apiKey });
      // Pass the 1M beta so eligible models report their extended
      // max_input_tokens — used to derive [1m] variants dynamically.
      const page = await withTimeout(
        client.models.list({ limit: 100, betas: [CONTEXT_1M_BETA] }),
        CLAUDE_MODELS_TIMEOUT_MS,
        'Anthropic models.list() timed out'
      );

      const allModels: Anthropic.ModelInfo[] = [];
      for await (const model of page) {
        allModels.push(model);
      }

      const options = toModelOptions(allModels);
      if (options.length === 0) {
        console.warn('[Claude Models] API returned no alias-style models, falling back to static');
        return STATIC_RESULT;
      }

      console.log(
        `[Claude Models] Fetched ${options.length} models for user ${userId ? shortId(userId) : 'unknown'} (source: ${resolution.source})`
      );
      return {
        default: DEFAULT_CLAUDE_MODEL,
        models: options,
        source: 'dynamic',
      };
    } catch (err) {
      console.warn(
        '[Claude Models] Anthropic models.list() failed, falling back to static list:',
        err instanceof Error ? err.message : err
      );
      return STATIC_RESULT;
    }
  }
}

export function createClaudeModelsService(db: Database): ClaudeModelsService {
  return new ClaudeModelsService(db);
}
