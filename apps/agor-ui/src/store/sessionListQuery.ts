/**
 * The one place session LIST reads that feed the store are shaped.
 *
 * Every such read is `lean: true` (#2887): rows withhold the bulky
 * single-session `custom_context` keys (LEAN_SESSION_LIST_OMITTED_CONTEXT_KEYS),
 * so `sessionById` is never the source for those. The open session reads them
 * from its full `sessions.get`. `lean` composes with every SQL fast-path key
 * (`created_by`, `session_id: { $in }`, `board_id`, …).
 */
export function sessionListQuery<Q extends Record<string, unknown>>(query: Q): Q & { lean: true } {
  return { ...query, lean: true };
}
