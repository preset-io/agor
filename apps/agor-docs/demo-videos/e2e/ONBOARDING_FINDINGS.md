# Onboarding findings from the demo-video E2E suite

Issues, workarounds, and friction discovered while scripting the from-zero
syllabus (`tests/flow/`) against a real daemon + UI. Each lesson drives the
actual onboarding path a new user walks, so everything here was hit "for
real" — not hypothesized. Ordered by how much I'd want it fixed.

Status legend: 🐛 bug worth filing · 🔧 fixed on this branch, needs to land ·
💡 UX/polish suggestion · 📝 observation / ecosystem limitation

---

## 1. 🐛 Daemon survives fatal startup errors as a zombie (EADDRINUSE)

`apps/agor-daemon/src/index.ts:124` installs a global `uncaughtException`
handler that logs `💥 [FATAL]` and **keeps running**. That's defensible for
steady-state stability, but it also swallows _startup_ failures: when the
listen port is already taken, the daemon logs
`listen EADDRINUSE: address already in use ::1:3131` and then... stays alive,
never bound to anything, while background loops (task queue, scheduler,
health monitor) all start up against a server that isn't serving.

We hit this exactly the way a new user would: an earlier daemon was still
running, a second `daemon start` appeared to succeed (process up, logs
flowing), and everything downstream behaved bizarrely — the _old_ daemon
answered every request with old state. It cost us a full 8-lesson recording
run before the log line surfaced the truth.

**Suggestion:** during the startup phase, let fatal errors be fatal —
exit non-zero on a failed `listen` (or handle the server's `error` event
explicitly and print "port 3131 is already in use, is another daemon
running?"). The global swallow-everything handler should only arm after the
server is successfully listening.

## 2. 🔧 `check-auth` never probed `ANTHROPIC_AUTH_TOKEN` connections

The Settings UI documents connecting Claude via an OAuth token
(`ANTHROPIC_AUTH_TOKEN`) + optional base URL, and sessions run fine that
way — but `check-auth` only knew how to probe `x-api-key` credentials, so
the amber "No AI connected — sessions will open but nothing will run"
banner **never cleared** for a correctly configured workspace. For a new
user this is the worst kind of onboarding message: a warning that says
setup failed when it succeeded.

Fixed on this branch (`6de860217`, `apps/agor-daemon/src/services/check-auth.ts`
now probes with the Bearer scheme the SDK actually transmits, + 2 tests).
Needs to land on `main`.

## 3. 🐛 Credential verification result depends on field save order

With a custom Anthropic base URL (enterprise gateway, proxy), the
verification probe uses the **saved** connection, not the form state. Save
the API key first and the probe fires at `api.anthropic.com`, fails or
misleads; save the base URL first and everything verifies. Our automation
had to encode "base URL before token" as a hard ordering rule
(`support/agent-settings.ts`) — a human filling the form top-to-bottom has
no way to know this.

**Suggestion:** verify against the form's current values, or re-run the
probe whenever any field of the connection is saved.

## 4. 🐛 Onboarding wizard auto-clones from GitHub the moment it mounts

`useEnsureFrameworkRepo` fires a network clone of
`preset-io/agor-teammate` as soon as the wizard mounts, and re-fires on
every page load while onboarding is incomplete — before the user has chosen
anything, teammate step or not. On an offline, air-gapped, or
firewall-restricted first run this is a silent repeated network fetch with
no consent, no progress UI, and no failure feedback. The harness had to
pre-register a local clone under the exact slug just to keep recordings
network-free.

**Suggestion:** defer the clone until the user actually picks a
teammate-flavored goal (or reaches the teammate step), show it happening,
and handle failure visibly.

## 5. 💡 Every navigation costs a 3–5s "Loading workspace data…" screen

Measured across all 8 lessons on a **fresh, near-empty SQLite database** on
a fast local machine: 3.3–5.1 seconds from navigation to usable UI (our
recordings trim it out; a user can't). First impressions are formed inside
that window. Worth profiling what the workspace bootstrap actually waits on
serially — with one board, one repo, and zero sessions it should be
near-instant.

## 6. 💡 Wizard skip friction: one "Skip for now" per step

Completing the wizard without setup means clicking "Skip for now" up to six
times in a row (our lesson 00 literally loops it). Each skip is a full step
transition. A single "skip the rest — take me to my board" affordance would
respect the user who has decided to explore first. Related polish: the
board the wizard creates is named "Admin's board", which slugs to
`/b/admin-s-board/` — the apostrophe-to-`-s-` mangling makes an ugly first
URL that's also the workspace's most-shared link.

## 7. 📝 Transient error on a just-created branch card (early observation)

Our very first scripted branch demo ended with an error state on the fresh
branch card; re-scripting to wait for filesystem readiness (the card
offering "New Session") made it reproducibly clean, and lesson 02 now
asserts no `failed|error` text ever appears. #2519 ("wait for branch
filesystem readiness") looks like the same class of race from the MCP side.
If prompting/acting on a branch before its worktree materializes can still
surface an error to the UI, that window deserves a "preparing…" state
instead — a new user's first branch erroring, even transiently, reads as
"it's broken".

## 8. 📝 Codex CLI ignores `OPENAI_BASE_URL` (ecosystem limitation)

Verified empirically: a stub endpoint set via `OPENAI_BASE_URL` got zero
hits from Codex runs (config-file `model_providers` is the only routing it
respects). This limits Agor's ability to route Codex through gateways or
record/replay proxies via env alone, and is worth a note in the provider
docs so enterprise users don't assume env-var routing works uniformly
across agents the way it does for Claude.

## 9. 💡 "Invite a teammate" doesn't invite, and can't invite a human

Two related paper cuts found while scripting the multiplayer lesson:

- There is **no invite flow** — no email invite, no shareable join link. The
  Home checklist item "Invite a teammate" just opens Settings → Admin →
  Users, where an admin types the new person's email **and password** for
  them. Fine for a demo, awkward for a real team ("what's my password?" →
  the admin knows it).
- The checklist item's _done_ state is `hasTeammates` — which counts **AI**
  teammates. Create an AI teammate and "Invite a teammate" checks itself
  off with zero humans invited. The copy and the predicate disagree about
  what a "teammate" is.

**Suggestion:** even without email infrastructure, a one-time invite link
(pre-created account, set-your-own-password on first visit) would remove
the admin-knows-your-password moment; and the checklist predicate should
count human users, not AI teammates.

Related: a newly created user's **first login runs the full onboarding
wizard** ("Ada, what do you want to get done?") — goal cards, teammate
step, AI step, and a fresh personal board — even when they were added to
an existing workspace and given a board URL. The wizard overlays the board
they were trying to reach. There's no "you were added to <workspace>, here's
the board" arrival path; a person joining a team probably shouldn't be
routed through the solo-founder setup flow before seeing the thing they
came for.

## 10. 🐛 Host CPU pressure gets a healthy running task killed (heartbeat_lost)

Observed for real during a 4K recording run: with the machine busy
(Chromium rasterizing at deviceScaleFactor 2 + a VP8 encoder + the daemon +
Vite all competing), the executor's socket missed pings for ~200s
(`[executor] Socket disconnected: ping timeout`), the daemon committed
`task.termination cause=heartbeat_lost`, and SIGTERM'd a Claude turn that
was ~4 minutes into productive work. The executor reconnected 25 seconds
later (attempt 2) — but the task was already dead and the turn's work lost.
The UI showed "Can't reconnect — reload" and the session sat RUNNING with
no reply.

A laptop under load (video call, build, indexing) is a normal environment
for exactly the users Agor courts. Losing a long agent turn to transient
CPU starvation is expensive — the turn is metered and unrecoverable.

**Suggestion:** tolerate longer heartbeat gaps when the executor process is
demonstrably alive (it reconnected on its own), e.g. for local mode verify
process liveness before committing termination, or grade termination on
repeated reconnect failure rather than a single ping-timeout window. Note
the containment machinery is deliberately race-fenced
(`context/concepts/task-runtime-state.md`) — the fix belongs in a focused
PR with reconciler tests, not a drive-by.

**Workaround that works today:** `execution.executor_heartbeat.stale_after_ms`
in config.yaml — the demo harness sets 900000 (15 min) in its scratch
AGOR_HOME and the kills stop. Worth documenting for users who run agents on
laptops that sleep/load up.

## 11. 📝 Config upgrades can leave a real installation needing hand-edits

An upgraded real-world `~/.agor/config.yaml` (retired `credentials:` block
present, `deployment_id` missing) needed manual repair before the daemon
behaved. The `RETIRED_CONFIG_KEYS` machinery handles the "don't crash" half
well; the missing half is telling the user _what to do_: a startup line per
retired key ("`credentials:` is retired and ignored — see <doc>") and
auto-filling genuinely required new keys would close it.

---

_Compiled 2026-08-30 while building the demo-video syllabus. Repro details
for 1–4 live in the suite: `support/harness.ts` (port reaper, framework repo
pre-registration), `support/agent-settings.ts` (save-order workaround),
`cassettes/` + `check-auth` tests on this branch._

## 12. 🐛 Teammate assignment offered, then refused — with expert-only guidance

The board panel's "Assign an existing teammate" select happily offers a
teammate that lives on another board, then the assignment fails with:
_"Failed to assign teammate: Switch this branch to an explicit permission
override before moving it to another board."_ Hit for real scripting
lesson 09.

Two layers of friction:

- The select shouldn't offer (or should annotate) options the policy layer
  will reject; the precondition is knowable before the click.
- The error speaks RBAC internals ("explicit permission override") — and
  with `branch_rbac` **off** (the default), the Permissions UI that could
  satisfy it isn't even reachable, making the suggested fix a dead end in
  the default configuration.

Worth deciding: either allow the move when RBAC is off, or filter the
select to same-board/movable teammates and phrase the error for humans.
(The demo lesson now follows the product's own model instead — each
teammate presides over its own board.)
