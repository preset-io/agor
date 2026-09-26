/**
 * The widget registry union's `result_meta` rule, asserted at the type level.
 *
 * Not a `.test.ts` on purpose: the daemon's `tsconfig.json` EXCLUDES every
 * `.test.ts` file, so a `@ts-expect-error` written in one is never checked by
 * anything — it would sit there looking like a guarantee and enforcing
 * nothing. This file is ordinary compiled input to `pnpm typecheck`, where an
 * unused `@ts-expect-error` is itself an error, which is what makes the
 * refusal below permanent. There is nothing to assert at runtime: the whole
 * point is that the rejected shape never reaches a daemon.
 *
 * The rule: a submit-resolved entry produces its `result_meta` either from
 * `applySubmit` (which must then return one) or from `buildResultMeta` (which
 * may then let the handler return nothing). The third arrangement — a real
 * `TResultMeta`, no builder, and a handler free to return nothing — used to be
 * expressible, and it is never correct: `submissions.ts` would pass `undefined`
 * to `buildAutoResumePrompt(result_meta, params)`, which is declared to receive
 * the shape, so the prompt the agent is resumed with reads properties off
 * nothing. F3 produced exactly that failure by another route — a `WeakMap`
 * miss answering with a blank channel id and `enabled: false`, the right shape
 * and the wrong answer — and the fix was to let the handler return its own
 * meta. This makes "one of the two" the type's rule rather than a convention.
 */

import { z } from 'zod';
import type { WidgetRegistryEntry } from './registry.js';

type Meta = { channel: string };
type Submit = { token: string };
type Params = Record<string, never>;

const base = {
  type: 'env_vars' as const,
  schemaVersion: 1,
  paramsSchema: z.object({}),
  submitSchema: z.object({ token: z.string() }),
  buildAutoResumePrompt: (meta: Meta) => meta.channel,
  buildDismissedPrompt: () => '',
};

/** Allowed: the handler is the only source, and it always returns one. */
export const handlerProducesMeta: WidgetRegistryEntry<Params, Submit, Meta> = {
  ...base,
  applySubmit: async () => ({ channel: 'C1' }),
};

/** Allowed: a builder is the fallback, so the handler may return nothing. */
export const builderIsTheFallback: WidgetRegistryEntry<Params, Submit, Meta> = {
  ...base,
  buildResultMeta: (submit) => ({ channel: submit.token }),
  applySubmit: async () => undefined,
};

/** Refused: nothing can produce the `Meta` this entry promises. */
export const neitherSourceIsRefused: WidgetRegistryEntry<Params, Submit, Meta> = {
  ...base,
  // @ts-expect-error a handler that may return void requires buildResultMeta
  applySubmit: async () => undefined,
};

/** Still expressible, and honest: no meta promised, none produced. */
export const noMetaAtAll: WidgetRegistryEntry<Params, Submit, void> = {
  ...base,
  buildAutoResumePrompt: () => '',
  applySubmit: async () => undefined,
};
