/**
 * Daemon → Executor config projection
 *
 * Strict subset of {@link AgorConfig} the daemon resolves once at spawn time
 * and embeds in the executor payload. Lives in @agor/core so both packages
 * type-check against the same shape — the daemon's builder uses
 * `satisfies ResolvedConfigSlice` and the executor's payload schema uses the
 * same zod schema for runtime validation.
 *
 * Letting the executor read `~/.agor/config.yaml` itself is broken under
 * impersonation — the file is mode 0600 owned by the daemon user, and the
 * executor running as a different uid can't read it. It also doesn't survive
 * any future deployment where executor and daemon live in different
 * containers.
 *
 * Instead: daemon resolves the small set of fields the executor actually
 * needs and ships them in the payload. Handlers must apply their own
 * defaults when a field is absent (legacy CLI mode has no payload).
 *
 * Grow this carefully — every field is new daemon → executor coupling. If a
 * handler needs a config value that isn't here, add it explicitly.
 */

import { z } from 'zod';

// Intentionally NOT `.strict()` at any level. The producer (daemon) and
// consumer (executor) may end up running from different image versions in
// templated / remote executor mode — exactly the topology this whole effort
// is preparing for. A schema that rejects unknown fields would mean a
// newer daemon adding a resolved-config field crashes every older executor
// pod, instead of those pods just ignoring the field they don't recognize.
//
// Typo-catching on the producer is preserved at compile time by
// `satisfies ResolvedConfigSlice` in `build-resolved-config-slice.ts`, so
// we don't lose that property where it actually matters.
export const ResolvedConfigSliceSchema = z.object({
  /** From `config.execution.*` */
  execution: z
    .object({
      permission_timeout_ms: z.number().int().nonnegative().optional(),
    })
    .optional(),

  /** From `config.opencode.*` */
  opencode: z
    .object({
      serverUrl: z.string().optional(),
    })
    .optional(),

  /** From `config.daemon.*` (selected fields only) */
  daemon: z
    .object({
      host_ip_address: z.string().optional(),
    })
    .optional(),
});

export type ResolvedConfigSlice = z.infer<typeof ResolvedConfigSliceSchema>;
