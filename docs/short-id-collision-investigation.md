# Short session-ID collisions in URLs — investigation

**Branch:** `investigate-short-id-collisions`
**Date:** 2026-04-22
**Status:** Proposal only — no code changes. Awaiting direction before implementation.

---

## TL;DR

- Session IDs **are** UUIDv7 (`uuid` npm package, `v7` import). The user's hunch was correct.
- The 8-char URL prefix `019db674` is **exactly the top 32 bits of the 48-bit `unix_ts_ms` timestamp**. It carries *zero random bits*.
- Therefore: any two sessions whose creation timestamps fall in the same ~65.5 s window share the 8-char prefix **deterministically**. This is not a birthday-paradox event; it is guaranteed.
- The UI resolver at `apps/agor-ui/src/hooks/useUrlState.ts:162-181` (`resolveSessionFromShortId`) returns the **first** session in `sessionById.values()` whose short ID matches — with no ambiguity check. Whichever session "wins" depends on Map insertion order, which can differ between page loads. That is the UX glitch.
- No backend prefix resolution exists for sessions; the whole short-ID round-trip is client-side.
- **Recommended fix:** hybrid of (a) bump URL prefix length from 8 → 16 chars, and (b) make the resolver ambiguity-aware (return the newest match + log/diagnose, or surface a disambiguation view). See "Recommended fix" below.

---

## 1. What's actually happening

### 1.1 ID generation — confirmed UUIDv7

`packages/core/src/lib/ids.ts:15-65`:

```ts
import { v7 as uuidv7 } from 'uuid';
// ...
export function generateId(): UUID {
  return uuidv7() as UUID;
}
```

All Drizzle primary keys use the same helper via `$defaultFn(() => generateId())` — per the design doc at `context/concepts/id-management.md:152-168`. This applies uniformly to `session_id`, `worktree_id`, `task_id`, `board_id`, `artifact_id`, `message_id`, etc. The visible pattern (every ID today starts with `019db…`) is consistent with UUIDv7's `unix_ts_ms` prefix for the current era (the `019d…` high nibble rolls over roughly every 32 days).

**UUIDv7 hex layout** (32 hex chars, hyphens removed):

| hex positions | bits | meaning |
|---|---|---|
| 0–11 | 48 | `unix_ts_ms` (Unix ms timestamp) |
| 12 | 4 | version nibble (always `7`) |
| 13–15 | 12 | `rand_a` (random, 12 bits) |
| 16 | 4 | variant (top 2 bits fixed `10` → char ∈ `{8,9,a,b}`) + 2 bits `rand_b` |
| 17–31 | 60 | `rand_b` (remaining random) |

### 1.2 Link building — 8 chars, sliced from the front

`apps/agor-ui/src/hooks/useUrlState.ts:43-45` (and the equivalent `toShortId` in `packages/core/src/types/id.ts:86-88`):

```ts
function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 8);
}
```

Used by `buildUrl` at lines 102-108 to form `/b/<board>/<session>/`. Same pattern in `packages/core/src/utils/url.ts:30-39` (`getSessionUrl`) for external links.

So the URL `/ui/b/jarvis/019db674/` is **not** a truncated display of the full ID — it is literally the 8-char string that was put into the URL, and it must be resolved back to a full UUID on the receiving side.

### 1.3 Prefix resolution — the smoking gun

`apps/agor-ui/src/hooks/useUrlState.ts:162-181`:

```ts
const resolveSessionFromShortId = useCallback(
  (sessionShortId: string): string | null => {
    const normalizedShortId = sessionShortId.replace(/-/g, '').toLowerCase();

    for (const session of sessionById.values()) {
      const sessionShortIdNormalized = shortId(session.session_id).toLowerCase();
      if (
        sessionShortIdNormalized.startsWith(normalizedShortId) ||
        normalizedShortId.startsWith(sessionShortIdNormalized)
      ) {
        return session.session_id;
      }
    }
    return null;
  },
  [sessionById]
);
```

Three problems, in order of severity:

1. **First-match-wins.** The loop iterates `sessionById.values()` and returns on the first hit. `sessionById` is a `Map`, so iteration order = insertion order. Whichever session was loaded into the Map first "owns" the prefix for this page load. Re-load with a different fetch order and the other session wins. This is the non-deterministic routing the user is seeing.
2. **No ambiguity signal.** Even if two sessions match, the caller gets back exactly one ID with no error, no warning, no disambiguation UI.
3. **Bidirectional `startsWith`.** `a.startsWith(b) || b.startsWith(a)` means a URL with fewer than 8 chars still matches — e.g. `/019d` would match any session since every full short ID starts with `019d`. This is permissive by design (meant to support short-prefix URLs) but amplifies the collision surface.

Backend: I searched `apps/agor-daemon/src` for `LIKE '...%'`, `expandPrefix`, `shortId`, `startsWith`, etc. The daemon does **not** resolve short session IDs; all the short-ID plumbing is client-side. REST calls hit session endpoints by full UUID.

Also note the route shape at `apps/agor-ui/src/App.tsx:1269`:

```
/b/:boardParam/:sessionParam/
```

`sessionParam` accepts whatever string is in the URL; the `useUrlState` hook does the resolution.

---

## 2. Why the 8-char prefix collides deterministically

8 hex chars = 32 bits. For UUIDv7, those 32 bits are the *top* 32 bits of the 48-bit `unix_ts_ms`. The dropped bottom 16 bits = 2¹⁶ = **65,536 ms ≈ 65.5 seconds** of timestamp resolution discarded.

Formal collision condition: two UUIDv7s share an 8-char prefix **iff**

```
floor(ts_ms_A / 65_536) == floor(ts_ms_B / 65_536)
```

So two sessions collide whenever they were generated in the same 65.5-second bucket. This is not a probability — it is a guarantee. For an orchestrator that routinely spawns multiple sessions within a minute (which Agor's `agor_sessions_spawn`, fork, and subsession flows do), 8-char prefix collisions are **expected**.

### The docs predicted safety incorrectly

`context/concepts/id-management.md:87-96` gives this table:

> | Total IDs | Collision Probability |
> |---|---|
> | 1,000 | 0.01% |
> | 10,000 | 1.16% |
> | 65,536 | 50% (birthday paradox) |
> | 100,000 | 77% |

That analysis is correct for **random** 32-bit prefixes (UUIDv4). It is the wrong model for UUIDv7, where the 32-bit prefix is a compressed timestamp. The design doc assumed random prefixes — the implementation switched to UUIDv7 for DB performance (`id-management.md:29-46`) and the short-ID collision model was never updated to match.

### Concrete burst-collision rate

If an orchestrator spawns `N` sessions uniformly over `T` seconds, the expected number of 8-char-prefix-colliding **pairs** is approximately

```
pairs ≈ C(N, 2) * (65.5 / T)     for T >> 65.5 s
pairs ≈ C(N, 2)                   for T ≤ 65.5 s (everyone collides with everyone)
```

Some examples:
- 10 sessions spawned over a minute: ~45 colliding pairs (basically all of them).
- 10 sessions spawned over an hour: ~45 × 65.5/3600 ≈ 0.8 pairs expected, i.e., almost certainly at least one collision.
- 100 sessions spawned evenly across a day (86,400 s): ~4950 × 65.5/86400 ≈ 3.8 expected pairs.

A single Agor session doing parent + a child spawn will always land both sessions in the same bucket because they're seconds apart. Likewise any fork/subsession flow.

---

## 3. Options considered

| # | Option | Fixes root cause? | Blast radius | Verdict |
|---|---|---|---|---|
| 1 | Full UUID in URLs | Yes | Ugly URLs; breaks muscle memory for short URLs the user already shares | Reject |
| 2 | **Longer prefix (16 chars)** | Yes | Tiny — single number change, touches ~3 call sites; old 8-char URLs still work via resolver's bidirectional `startsWith` | **Accept (primary)** |
| 3 | Switch to UUIDv4 / ULID / nanoid | Yes | Large — DB migration, loses UUIDv7 sort order, breaks every saved URL, breaks `context/concepts/id-management.md` | Reject |
| 4 | **Ambiguity-aware resolver** | Partially (defensive) | Tiny — single function change | **Accept (defensive layer)** |
| 5 | Separate random `short_slug` column | Yes | Large — migration, new indexed column, slug-generation, backfill | Defer (revisit if 16-char prefix feels wrong long-term) |

### Why 16 chars is the right number

Looking at the UUIDv7 layout in §1.1:

| Prefix length | Random bits included | Buckets per ms | Comment |
|---|---|---|---|
| 8  | 0  | 1      | status quo — collides every 65.5 s |
| 12 | 0  | 1      | exact ms resolution, still collides within 1 ms |
| 13 | 0  | 1      | adds fixed `7` version nibble — still no random |
| 14 | 4  | 16     | first 4 bits of `rand_a` — weak |
| 16 | 12 | 4,096  | full `rand_a` — **sweet spot** |
| 17 | ~14 | ~16,384 | adds 2 bits of `rand_b` past the variant |

At 16 chars, two sessions collide only if their `unix_ts_ms` is identical **and** their 12-bit `rand_a` is identical. With 4,096 values of `rand_a` per ms, a birthday collision among 10 sessions issued in the exact same millisecond is ≈ 45 / 4096 ≈ 1.1 %; among 5 sessions in the same ms ≈ 0.24 %. UUIDv7 generators (including `uuid` npm) typically also include a monotonic counter in `rand_a` during the same ms, which *further* reduces within-ms collisions to nearly zero in practice.

12 chars (full 48-bit timestamp) would still collide for any two sessions created in the same millisecond — not unreasonable during spawn storms. 16 is safer and still short enough to be pleasant in URLs: `019db67412ab7fed`.

---

## 4. Recommended fix

**Hybrid: bump short-ID length to 16 + make resolver ambiguity-aware.**

### 4.1 Bump URL prefix length from 8 → 16

Change the default length used when generating session/board URL slugs. Old URLs keep working because the resolver uses bidirectional `startsWith` (a stored 8-char link matches a 16-char live session).

**Files to touch:**

- `packages/core/src/lib/ids.ts:136` — `shortId(uuid, length = 8)`: keep the generic default at 8 (other UIs rely on it for compact display), but introduce a named constant, e.g. `URL_SHORT_ID_LENGTH = 16`, exported for URL building.
- `apps/agor-ui/src/hooks/useUrlState.ts:43-45,102-108` — replace the local `shortId` to use `URL_SHORT_ID_LENGTH` for URL construction. Leave the resolver's normalization at the full length it receives from the URL.
- `packages/core/src/utils/url.ts:37-38,65` — `getSessionUrl` / `getBoardUrl`: pass the URL length.
- Any component that builds a `/b/.../sessionId` href. Grep `shortId(` and `toShortId(` in `apps/agor-ui/src`. The table/pill/display call sites at `SessionTitle`, `Pill`, `ArtifactsTable`, `MCPServersTable`, `MessageBlock` etc. are **display**, not URL, and should stay at 8 for compactness.

Migration notes:
- No DB migration. Full UUIDs remain in the database.
- Old emails/Slack links containing 8-char IDs will resolve correctly **as long as** the resolver's bidirectional `startsWith` is preserved *and* ambiguity is handled (see §4.2). If we ever remove the bidirectional behavior, old 8-char links become ambiguous and break.

### 4.2 Make the resolver ambiguity-aware

`apps/agor-ui/src/hooks/useUrlState.ts:162-181` — replace the first-match-wins loop with a collect-all-matches pattern and explicit handling:

```
1. collect ALL sessions whose prefix matches (both directions)
2. if 0 matches  -> return null (already does)
3. if 1 match    -> return it
4. if >1 matches -> pick most-recently-updated session
                  + log a console.warn in dev
                  + optionally surface a toast: "Multiple sessions
                    matched this short ID — showing most recent"
```

Picking the newest match is a reasonable default (matches user intent when they click a freshly-sent link) and is deterministic across reloads, which eliminates the reported "sometimes A, sometimes B" symptom even for the backward-compat case where old 8-char URLs collide in data created today.

Exported helper candidate in `packages/core/src/lib/ids.ts`: add `resolveShortIdPrefixAll()` to return all matches, used by both the existing CLI `resolveShortId` and the new UI path.

### 4.3 Update the design doc

`context/concepts/id-management.md:87-144` still describes the collision math as if prefixes were random. Rewrite that section to:
- call out that UUIDv7 gives a timestamp prefix, not random bits
- document the chosen URL length (16) and why
- document the resolver's tie-break (most-recent)

This is important because the doc will guide future decisions and the current math is misleading.

### 4.4 Test coverage

Add tests in `packages/core/src/lib/ids.test.ts`:
- `generateId()` called twice in the same ms → 8-char prefix equal, 16-char prefix differ (under the current `uuid` library behavior).
- `resolveShortIdAll(prefix, entities)` returns all matches (vs. throwing).

And in `apps/agor-ui/src/hooks/useUrlState.ts` tests (if any exist — if not, a colocated test file):
- two sessions with identical 8-char prefix → URL with the new 16-char prefix routes to the correct one.
- URL with the legacy 8-char prefix matching both → resolver picks the newest.

---

## 5. Open questions for the user

1. **Tie-break policy for ambiguous legacy URLs.** "Most-recently-updated" is my proposal. Alternatives: most-recently-created, the one owned by the current user, or a disambiguation UI listing candidates. Preference?
2. **Display-side short IDs** — stay at 8 chars (pills, tables, tooltips)? The argument for 8 is compactness; the argument for matching URLs is consistency. I'd leave display at 8 since ambiguity there is a different UX (hover shows full UUID anyway).
3. **Board short IDs** in URLs — same treatment (8 → 16) or leave them at 8? Boards are lower-cardinality and usually addressed via `slug`, so collisions are much rarer. Probably fine to leave, but worth a decision so we're consistent.
4. **Worktree / artifact / task IDs.** Any other entity currently addressed by 8-char prefix in URLs or CLIs? A quick audit would confirm.
5. **Are we OK with slightly longer visible URLs** (`/b/jarvis/019db67412ab7fed/` vs `/b/jarvis/019db674/`)? If not, the dedicated slug column (Option 5) is the alternative.
6. **Backend resolver** — do we want to add a `/sessions/resolve/:shortId` endpoint that can disambiguate with server-side knowledge (e.g., ownership, access)? Today everything rides on the client-loaded `sessionById` map, which means the resolver can only see sessions the UI has already fetched.

---

## Appendix: files cited

- `packages/core/src/lib/ids.ts:15,63-65,136` — UUIDv7 generation and `shortId`
- `packages/core/src/types/id.ts:86-88` — `toShortId`
- `packages/core/src/utils/url.ts:30-39,60-67` — external URL builders
- `apps/agor-ui/src/hooks/useUrlState.ts:43-45,96-111,136-181` — URL building and prefix resolver
- `apps/agor-ui/src/App.tsx:1269` — route `/b/:boardParam/:sessionParam/`
- `context/concepts/id-management.md:87-144` — outdated collision math
