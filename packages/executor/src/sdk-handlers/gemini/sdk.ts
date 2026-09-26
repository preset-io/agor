import { loadManagedAgenticToolSdk } from '@agor/core/agentic-integrations';
import type * as GeminiTypes from '@google/gemini-cli-core';

// The SDK opens this sink during module evaluation, before runtime suppression.
delete process.env.GEMINI_DEBUG_LOG_FILE;
export const Gemini = await loadManagedAgenticToolSdk<typeof GeminiTypes>('gemini');
