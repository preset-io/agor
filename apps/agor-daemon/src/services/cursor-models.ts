/**
 * Cursor Models Service
 *
 * Exposes `Cursor.models.list()` from @cursor/sdk as a Feathers endpoint so the
 * UI can render the live model list available to the caller's Cursor account.
 * Falls back to Cursor's documented default alias when no key is configured or
 * the SDK call fails.
 */

import { resolveApiKey } from '@agor/core/config';
import { shortId, type TenantScopeAwareDatabase } from '@agor/core/db';
import { CURSOR_MODEL_METADATA, DEFAULT_CURSOR_MODEL } from '@agor/core/models';
import type { Params, UserID } from '@agor/core/types';
import { Cursor, type SDKModel } from '@cursor/sdk';

export interface CursorModelOption {
  id: string;
  displayName: string;
  description?: string;
  source: 'dynamic' | 'static';
}

export interface CursorModelsResult {
  default: string;
  models: CursorModelOption[];
  source: 'dynamic' | 'static';
}

const CURSOR_MODELS_TIMEOUT_MS = 8_000;

const STATIC_RESULT: CursorModelsResult = {
  default: DEFAULT_CURSOR_MODEL,
  models: [
    {
      id: DEFAULT_CURSOR_MODEL,
      displayName: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].displayName,
      description: CURSOR_MODEL_METADATA[DEFAULT_CURSOR_MODEL].description,
      source: 'static',
    },
  ],
  source: 'static',
};

interface AuthenticatedParams extends Params {
  user?: { user_id: UserID };
}

function toModelOption(model: SDKModel): CursorModelOption {
  return {
    id: model.id,
    displayName: model.displayName || model.id,
    description: model.description,
    source: 'dynamic',
  };
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

export class CursorModelsService {
  constructor(private db: TenantScopeAwareDatabase) {}

  async find(params?: AuthenticatedParams): Promise<CursorModelsResult> {
    const userId = params?.user?.user_id;
    const resolution = await resolveApiKey('CURSOR_API_KEY', {
      userId,
      db: this.db,
      tool: 'cursor',
    });

    if (!resolution.apiKey) {
      console.log(
        `[Cursor Models] No Cursor API key for user ${userId ? shortId(userId) : 'unknown'} — returning static list`
      );
      return STATIC_RESULT;
    }

    try {
      const dynamic = await withTimeout(
        Cursor.models.list({ apiKey: resolution.apiKey }),
        CURSOR_MODELS_TIMEOUT_MS,
        'Cursor.models.list() timed out'
      );
      console.log(
        `[Cursor Models] Fetched ${dynamic.length} models for user ${userId ? shortId(userId) : 'unknown'} (source: ${resolution.source})`
      );
      return {
        default: DEFAULT_CURSOR_MODEL,
        models: dynamic.map(toModelOption),
        source: 'dynamic',
      };
    } catch (err) {
      console.warn(
        '[Cursor Models] Cursor.models.list() failed, falling back to static list:',
        err instanceof Error ? err.message : err
      );
      return STATIC_RESULT;
    }
  }
}

export function createCursorModelsService(db: TenantScopeAwareDatabase): CursorModelsService {
  return new CursorModelsService(db);
}
