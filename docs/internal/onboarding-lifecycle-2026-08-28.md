# Onboarding lifecycle and modal-loop incident (2026-08-28)

## Revision and history

- Audited `origin/main` and branch base: `200eefb66e0d1d4cc6b439536e7a0010e79d9ac5`
  (`fix(db): let migration 0095 reach every tenant under forced RLS (#2591)`).
- [#2293](https://github.com/preset-io/agor/pull/2293), merge
  `637d38a712eca0c48ae510c0a5bcfa8c3c913243`, added goal-card onboarding.
- [#2461](https://github.com/preset-io/agor/pull/2461), merge
  `f30b5e46f4672b8d2bbbdfab052bb19859f31267`, introduced the four-step flow,
  resumable board progress, and teammate-template provisioning.
- [#2480](https://github.com/preset-io/agor/pull/2480), merge
  `f8f093addae79f2f4b2a43c0db89c49e567feaed`, correctly made the
  authenticated user authoritative for login gates. It exposed the modal bug:
  the directory realtime update no longer changed the login-time
  `onboarding_completed` value used by App's auto-open effect.
- [#2555](https://github.com/preset-io/agor/pull/2555), merge
  `5ff672d98646f97226bf14284dace87c672fff9b`, added an auth refresh before
  close as an incidental mitigation. It stopped the usual success path on
  current main, but a refresh failure occurred after durable completion and was
  thrown back into a final screen that had no X. Visibility still had no
  explicit terminal state.

## Before: complete lifecycle and failure

1. App authenticates and enriches the authenticated principal with directory
   display fields, but preserves authoritative identity, role, password, and
   onboarding login gates.
2. Once user/auth hydration, connection, workspace route, password gate, and
   loading state allow it, an App effect opens onboarding for a member/admin
   with `onboarding_completed === false`. Viewers are excluded.
3. The wizard restores `preferences.onboarding` and moves through goals,
   teammate, AI, and done. Each of the first three steps can be skipped; back
   and next only alter local/progress state.
4. Done persists a canonical UUIDv7 board candidate, creates or discovers that
   board once, and retains its selections. Parent
   completion best-effort seeds a teammate branch/session, fetches the latest
   user, patches completion plus merged preferences, and navigates.
5. Before #2555, App then cleared its modal owner. Because the authenticated
   object still said `false`, the auto-open effect immediately allocated a new
   owner: observed transitions were `closed → open → closed → open`, with a
   remount on the last edge. Skipping made the race easier to see because
   provisioning was short.
6. On current main, App refreshes the auth object before closing. If that read
   fails after the completion patch, it reports an error without closing. The
   final screen deliberately hid X and Escape cancellation, so this partial
   fix still traps the user.

Root-cause confidence is **high**: source history identifies the authority
split, the old effect's dependency/owner transitions reproduce it with a stale
auth gate, and the browser regression harness holds that gate stale while the
new lifecycle closes exactly once.

## After: authoritative state machine

`useOnboardingLifecycle` is the sole visibility owner:

```text
idle --eligible + ready + incomplete + not deferred--> active
active --X/Escape--> deferred
active --durable completion write--> completed
active --role/identity loss--> idle
deferred --Settings Resume--> active (explicit, progress preserved)
deferred/completed --Settings Restart--> active (explicit, progress cleared)
deferred/completed --route/loading/realtime churn--> same terminal state
```

An owner is fenced by user ID, authentication generation, and an opaque
activation generation. Final submit also has a synchronous single-flight guard
and per-attempt generation. Duplicate native clicks cannot start a second
board create. Boards use a browser-safe canonical UUIDv7 generated through the
shared core encoder. The candidate is persisted before create, and an ambiguous
create response is resolved with `get(id)`, so reload or response uncertainty
cannot become a second board. The daemon rejects non-UUIDv7 client board IDs.
A slow attempt remains the single in-flight operation until it settles; timeout
observation never starts a second provisioning chain. Dismiss, identity
replacement, and remount fence late continuations, while deferral retains the
candidate ID. A retry reuses the saved board/branch/session IDs.

Completion becomes terminal immediately after the durable self-patch, before
navigation. The PATCH's realtime user event is allowed to win that race: a
same-activation `completed` terminal acknowledgement is idempotent, so the
completion continuation still navigates to its created board after the PATCH
promise resolves. Terminal state retains the activation generation, preventing
an older continuation from becoming current again after an explicit restart. A
`deferred` terminal state is deliberately not interchangeable with completion,
so X/Escape during that write still suppresses navigation. The
auth refresh is best-effort and runs only after close/navigation; failure shows
a reload warning instead of converting success into an error. Dismissal becomes
terminal synchronously, then writes `preferences.onboarding.deferredAt` from the
latest user snapshot. It never sets `onboarding_completed`. Failure to persist
deferral is visible, but cannot reopen the modal in the same authority generation.
X/Escape work on every step and throughout credential saves, board creation,
progress persistence, and cancellable provisioning. Dismissal waits for any
already-issued wizard/completion preference write before its latest-user read so
a stale whole-preferences patch cannot erase completion or deferral.

## Deterministic interaction matrix

Expected transition count is one open and one terminal close (`false, true,
false`) per automatic authority generation. The completion patch count is at
most one. Resource counts below are per completed onboarding.

| Axis                                  | Cases exercised/reasoned                                                              | Expected result and writes                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goals                                 | blank/skipped, one, two; back then change                                             | Same lifecycle. Progress may be patched per navigation; completion merges the latest preferences.                                                                                                                                                    |
| Teammate                              | blank/skipped; name without template; selected template; stale template ID            | Blank creates one board and no teammate. A valid name creates/discovers at most one branch/session. A stale ID is a visible validation error with zero final writes.                                                                                 |
| AI                                    | skipped; selected/authenticated; selected/unverified; auth/save error                 | Skip and authenticated selection can finish. Invalid/unverified state stays recoverable. Credential failure is visible and dismissible.                                                                                                              |
| Final success                         | any skip/selection combination                                                        | One board create or reuse; one progress patch; one completion patch; zero or one discovered/created branch and session; one terminal close; navigate to that session/board even if realtime completion closes first; no reopen with stale auth data. |
| Validation/progress failure           | invalid template, board create rejection/ambiguous response, progress patch rejection | No completion marker. Error remains visible; retry or X/Escape works. The client-generated board ID is retained/discovered rather than duplicated.                                                                                                   |
| Partial teammate provisioning failure | repo unavailable, branch/session failure                                              | Existing best-effort warning remains. Completion can commit once because the wizard is optional; retained IDs prevent duplicate retries.                                                                                                             |
| Completion failure                    | latest-user or completion patch rejects                                               | No terminal completion. Error and retry remain; X/Escape defers without lying about completion.                                                                                                                                                      |
| Slow completion / late resolution     | parent completion exceeds 45 s                                                        | A warning appears, X/Escape remain available, and the primary action stays disabled until the one attempt settles. Retry follows only a real rejection.                                                                                              |
| Duplicate/double submit               | two same-turn clicks                                                                  | Single-flight ref admits one create/progress/completion chain.                                                                                                                                                                                       |
| X / Escape                            | every step and every in-flight/error state                                            | Synchronous terminal defer and one sequenced preferences get/patch. Candidate progress is retained; no reopen. Mask click remains disabled.                                                                                                          |
| Browser back / route change           | before/during/after finish                                                            | Route/readiness churn never reasserts a terminal state. Back does not own the modal.                                                                                                                                                                 |
| Refresh/remount                       | fresh, partially saved, deferred, completed                                           | Fresh/partial resumes; deferred/completed stays closed; Settings Resume preserves progress and Restart clears it.                                                                                                                                    |
| Realtime user/role update             | preferences/completion churn; member/admin/viewer transitions                         | A same-user directory `true` is close-only, so another tab closes the wizard; directory `false` never opens it. Viewer cannot provision. Identity replacement retires old work.                                                                      |
| Viewports                             | desktop, phone, tablet, 667x375 short landscape                                       | Browser project runs the exact skip/final/stale-auth sequence in all configured viewports. X remains reachable.                                                                                                                                      |
| Identity                              | local or external identity                                                            | Preferences and completion remain Agor-owned. External claim-owned identity/role/password fields are unchanged.                                                                                                                                      |

## Authority, tenancy, and idempotency

No daemon authorization hook or persistence meaning was weakened. Automatic
onboarding still requires `canRunOnboarding` (member/admin); viewers never call
board, branch, or session provisioning. User get/patch, board, branch, and
session services retain authenticated tenant context and their existing
member/self/RBAC hooks and RLS. Deferral is a self-owned preference on the same
tenant-owned user row. External identity continues to reject claim-owned field
writes while allowing Agor-owned preferences and completion state.

The completion patch is still the commit point, after provisioning succeeds or
reaches its documented optional/best-effort outcome. Deferral is not
completion. Existing persisted board/branch/session IDs and discovery remain
the retry keys; a pre-create durable UUIDv7 board candidate, server validation,
and the single-flight guard close reload, ambiguous-response, and same-turn
duplicate-create windows.

## Validation

- Onboarding component/hook/preference/authority suites: 92/92 passed. These cover
  skip-all, selections, stale templates, failed and ambiguous board creation,
  pre-create candidate persistence/remount, progress/completion rejection, slow
  attempt single-flight behavior, same-turn double submit, retry reuse,
  cross-tab completion, authority replacement, X/Escape, and dismissal during
  a hung final attempt. Settings/surface resume-versus-restart behavior also
  passed 44/44.
- Real Chromium browser projects: 60/60 passed across the configured desktop,
  phone, tablet, and short-landscape viewports. The skip-all/stale-auth case
  asserted exact modal transitions `[false, true, false]`, one create, one
  progress write, one completion write, no reopen, an on-screen X, and navigation
  to the created board when the realtime completion event arrives before the
  completion PATCH promise settles.
- Isolated SQLite `dbTest`: 57/57 board and user-security tests passed, including
  rejection of client-supplied UUIDv4 board IDs and external identity
  persistence of deferral with `onboarding_completed === false`.
- Core ID suites: 63/63 passed, including browser generation without
  `crypto.randomUUID()`.
- `pnpm check`: 21/21 typecheck tasks passed. Workspace
  Biome/design-system lint checked 2,645 files and 330 color fixtures; short-ID,
  multitenancy, daemon-filesystem, and realtime boundary checks and all 15 build
  tasks passed.
- The UI suite completed 2,065 tests; three unrelated Ant Design-heavy tests
  hit the suite's 15-second parallel-load timeout. All three passed (11/11)
  when rerun together, as did the two timeout cases from the preceding run.
- The branch's managed SQLite environment reported `status: unknown` and was
  not started by the agent because branch dev/watch processes are user-owned.
  Browser validation therefore used the repository's managed Playwright
  projects rather than that inactive deployment.

## Rollout, rollback, and product decisions

This is a UI/type change with no schema migration. Roll out normally and watch
onboarding completion/defer errors plus duplicate onboarding resource reports.
Rollback is the code revert; existing `deferredAt` is an additive preferences
field ignored by older clients. If rolling back, remove that marker for users
who should see the older automatic wizard again.

Product decision recorded: a completely skipped flow still creates a board, and
the final “Open my board” action must navigate to that newly created board.

Product decisions still needed from Max:

1. Should “finish later” suppress onboarding indefinitely (the implemented,
   safety-first behavior) or should a separate, explicitly designed reminder
   reopen it after a defined interval?
2. Is 45 seconds the desired “taking longer than expected” warning threshold,
   or should telemetry support a different threshold before it becomes configurable?
