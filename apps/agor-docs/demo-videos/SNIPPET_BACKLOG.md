# Sizzle-reel snippet backlog

Working doc for consolidating booth-loop / sizzle-reel ideas from multiple
submitters, deduped against what's already built. All 3 batches are in and
reconciled (see "Cross-batch signal" below); the 3 net-new ideas from that
pass are now built too.

Resolutions: every booth-loop scene is encoded three ways —
`showcase-<name>.mp4` (1600×900, matches the website's carousel embed),
`booth-<name>-1080p.mp4`, and `booth-<name>-4k.mp4` (conference-TV masters,
not published to the site). All in `~/Desktop/agor_video/booth-loops/` (the
1080p/4k ones in their own subfolders). `encode.sh --booth <scene...>` is
the new mode that produces the TV masters — see its header comment.

## Already built

**7 original site scenes** (`apps/agor-ui/src/pages/marketing/scenes/`,
hero loop + showcase carousel): `multiplayer`, `session`, `artifact`,
`settings`, `boards`, `sessions` (loop variant), `gateway` (Slack chat-mirror).

**12 new booth-loop scenes** (this session, in `~/Desktop/agor_video/booth-loops/`):

1. `multiAgentRace` — same prompt, 4 models (Claude/Codex/Gemini/OpenCode) racing on one branch card; now with a real cursor pointing at the Claude/Gemini rows mid-race
2. `genealogyTree` — real fork/spawn family tree via `buildSessionTree`; now with a real cursor pointing at the root then the forked row, plus the frozen-`<Spin>` fix (the forked session is RUNNING)
3. `zoneDrop` — drag a card into Review, its zone trigger template fires as a toast; retrofitted with the frozen-`<Spin>` fix after the spinner audit below
4. `marketplace` — real Marketplace UI: browse catalog → open Clerk → pick branch → Connect
5. `teammateReveal` — AgorClaw presenting its own scheduled-teammate card
6. `scheduleFiring` — a cron-fired session live in the "Scheduled Runs" list; built with a real cursor pointing at the scheduled row and the frozen-`<Spin>` fix from the start
7. `leaderboard` — new Sandpack artifact, agents ranked by tasks/cost this week; now with a real cursor pointing down the Claude/Codex rows (visual-only — the artifact renders in a cross-origin Sandpack iframe, so it can't click into it)
8. `newBranch` — the real NewBranchModal, typed + submitted, then the branch materializes on the board already running (batches 1/2/3's #1/#03/#2, 3/3 convergence); retrofitted with the frozen-`<Spin>` fix
9. `worktreePr` — real Read→Edit→diff completing in the session panel, then the canvas pans to a second, unrelated branch card with its own PR (batch 1 #6 + batch 2 #09 + batch 3 #3, combined)
10. `knowledge` — **rebuilt to mount the real `KnowledgePage.tsx`** (sidebar tree, search box, `KnowledgeGraph` force layout) behind a stub `AgorClient`, not a custom recreation — see "Knowledge scene rebuild" below. A real cursor types "launch" into the real search box (real debounced `kb/search`), closes the dropdown, then hovers two real graph nodes. Stays on the graph-home default view the whole time to dodge a `navigate()`-unmount landmine (documents and search results both call `navigate()` synchronously; opening either would unmount the whole demo route).
11. `autoAdvance` — intentionally cursor-less: a card slides Ship→Review zones on its own the instant its session completes, no drag. The point of the shot is that nothing drives it.
12. `canvasHoverPreview` — the wide establishing shot every scene opens on, as its own clip: a real cursor visits two cards, each popping a small live-looking tooltip (diff/log lines) — the one differentiating detail batch 3 #1 added over the other two zoom-out pitches.

Skipped kanban-drag and Discord gateway (see below) — user call, not revisited.

Skipped: kanban-drag (redundant with `boards`/`zoneDrop`), Discord gateway
(Slack `gateway` scene already covers the story; a Discord version would need
a whole new ~450-line hand-rolled chat panel).

### Interaction-addition pass ("I want to see spinners spinning... more interaction, not just zooming in")

Evan's standing directive after reviewing the first cut: real cursors clicking
things, not static zoom/pan, and no frozen loading spinners. Response:

- **Frozen-`<Spin>` audit.** `MarketingVideoPage.tsx` forces antd
  `token.motion = false` for deterministic capture, which also freezes real
  CSS animations — including any RUNNING session's `<Spin>` dot. Fixed via a
  per-frame `ActionKeyframe` that manually rotates `.ant-spin-dot` transforms
  scoped to the branch's `data-session-id`. Applied to `multiAgentRace`,
  `genealogyTree`, `scheduleFiring` (built in from the start) and
  retrofitted to `zoneDrop`, `newBranch` after the audit.
  **Also found in the live site's `boards.ts` and `multiplayer.ts`**
  (both feature multiplayer-presence's RUNNING Codex session) — flagged to
  Evan, **not fixed**: fixing it means touching and republishing the public
  site's hero/carousel videos, which wasn't asked for. Open decision, see
  below.
- **Cursor interactions added** to `multiAgentRace`, `genealogyTree`,
  `scheduleFiring`, `leaderboard` — a labeled cursor arrives during the
  camera hold and points at specific rows, with click pulses. Row
  coordinates needed pixel recalibration in `genealogyTree`, `scheduleFiring`,
  and `leaderboard` after a first-pass screenshot showed a consistent
  one-row-too-low/high offset each time.
- **`autoAdvance` and `teammateReveal` reviewed against the same bar and
  left as-is.** `autoAdvance`'s whole premise is that nothing drives the
  card — adding a cursor would contradict the point of the shot.
  `teammateReveal` already had an AgorClaw-driven cursor from its original
  build, so it already satisfied the ask.
- **`canvasHoverPreview` built** as the answer to "zooming in and out of a
  static card isn't very cool" for the establishing-shot idea specifically —
  the 4-way-converged zoom-out pitch now has a real cursor and a live-looking
  hover payoff instead of being pure camera motion.

### Knowledge scene rebuild

First cut was a lightweight custom menu/doc/graph panel — visually close but
not the real product. Evan caught this from a screenshot ("is that just
made-up UI, or a screenshot of the real product... I was under the impression
these videos were OF the actual UI") and asked, via a follow-up choice, to
build the real `KnowledgePage` chrome rather than keep the simplified version
or drop Knowledge. Rebuilt to mount the actual 4500-line production component
via a stub `AgorClient` (`demoKnowledgePageClient.ts`) backed by fixture data
(`demoKnowledgePageData.ts`), wrapped in a positioned/rounded/shadowed div —
same "real inner components, custom outer chrome" pattern already used for
`DemoSessionStage`/`DemoMarketplaceStage`, disclosed to Evan as a nuance. The
scene deliberately never opens a document or search result, since both call
`navigate()` synchronously in the real component and would unmount the whole
`/demo/marketing-video` route mid-capture.

---

## Batch 1 (submitter A)

### Shared production grammar (proposed, not yet adopted)

- Canvas 1920×1080 @2x DPI, record 60fps / deliver 30fps.
- Synthetic cursor sprite (not Playwright's real cursor), `cubic-bezier(.22,.61,.36,1)` easing, 600–800ms per major move, never teleport.
- Typing: 22–30 chars/sec, ±15% jitter, 250ms pause before Enter.
- Beat structure: hook (0–2s) → action → payoff (last 2s, held still).
- One lower-third caption per clip, ~1s in, 4–6 words.
- Post-effect spotlight/dim-around driven by Playwright-emitted bounding boxes.
- One zoom OR one pan per clip, never both.
- Proposes a sidecar JSON per clip (`{t, action, selector, bbox}`) for a compositor to place captions/spotlights, +500ms dead air head/tail per clip.

This is a notably heavier pipeline than what we have — real timed compositing
(captions, spotlight effects, a synthetic cursor sprite) vs. our current
scene-authored-motion-in-React approach. Worth a deliberate call on whether
to adopt any of it, not just an implicit yes.

### 10 snippets

| #   | Name                            | Len | Overlap w/ existing                                          | Notes                                                                                                                                                                                                             |
| --- | ------------------------------- | --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Spawn an agent from the canvas  | 10s | None                                                         | Empty-canvas → double-click → spawn dialog → typed name+prompt → card animates in. We don't have an empty-canvas creation-flow scene yet.                                                                         |
| 2   | Fork to try another approach    | 12s | **High** — `genealogyTree`                                   | Ours shows a finished tree; this shows the live fork _gesture_ (hover message → "Fork from here" → sibling grows out). Complementary angle, not a straight dupe.                                                  |
| 3   | One prompt, a fleet of agents   | 13s | **High** — `multiAgentRace`                                  | Ours: 4 sessions on one card. This: 6 separate cards cascading onto canvas in a fan arc from one orchestrator prompt. Different visual treatment of the same idea.                                                |
| 4   | Zoom out: the whole operation   | 8s  | **High** — our WIDE establishing shots / `boards` scene      | Pure camera pull, tight→bird's-eye. We already do this as the opening beat of every scene; this proposes it as its own standalone clip.                                                                           |
| 5   | Live artifact on the board      | 11s | **Medium** — `artifact` scene, `leaderboard`                 | Novel part: cursor _interacts_ with the live app (clicks a button, it responds) — none of ours are interactive yet.                                                                                               |
| 6   | Worktree → branch → PR          | 12s | None                                                         | Diff preview + "Open PR" → GitHub link chip. Git/PR flow, nothing like it built yet.                                                                                                                              |
| 7   | Multiplayer presence            | 9s  | **High** — `multiplayer` scene                               | Second/third labeled cursor, simultaneous ticking counters. Close to what exists already.                                                                                                                         |
| 8   | Summon from Slack               | 12s | **High** — `gateway` scene                                   | Ours is split-screen Slack+session; this is cut/wipe between a full Slack window and the board. Same story, different edit.                                                                                       |
| 9   | Kanban zones: drag the workflow | 9s  | **High** — `zoneDrop`, `boards`, and our skipped kanban idea | Confirms our skip call. Novel piece: an agent-finished card _auto-advancing_ zones on its own, which we don't have.                                                                                               |
| 10  | Agents orchestrating agents     | 13s | **Low-Medium** — `genealogyTree`, `multiAgentRace`           | Meta/MCP angle: an orchestrator _agent_ (not a human) spawning workers, streaming commentary as children pop onto canvas. Distinct framing even where the visual (parent→children tree) rhymes with what we have. |

### Submitter's own suggestions

- Sizzle order: 1 → 3 → 4 → 5 → 10.
- Best standalone loops/thumbnails: 4 and 3.
- Cheapest to prove the pipeline first: 4 (camera only) → 9 (single drag) → 1.
- Offered to build a Playwright capture harness (synthetic cursor + event
  sidecar) for #4 as a proof of concept. **Not started** — holding until
  Evan decides whether to adopt this submitter's heavier pipeline vs.
  extending our existing scene-in-React approach.

---

## Batch 2 (submitter B)

### Global production spec (proposed, not yet adopted)

Same shape as submitter A's grammar, independently arrived at — worth noting
as a signal both external submitters converged on this:

- 1920×1080 @2x DPI, 60fps record / 30fps deliver (identical to submitter A).
- Fake DOM cursor overlay following `page.mouse.move`, ease-in-out 350–500ms
  per hop, click ripple on mousedown (same idea as A's synthetic cursor sprite,
  slightly faster hop timing: 350–500ms vs A's 600–800ms).
- Typing via `locator.pressSequentially(text, {delay: 45})` (~22 chars/sec) +
  blinking caret — same instinct as A's typing spec, converges on a similar rate.
- Determinism: seed fixed demo data, freeze timestamps, prefer `data-testid`
  hooks over CSS selectors and flag missing ones to eng.
- Every clip opens on a ~0.4s held frame, ends on a ~0.8s held payoff frame.
- One kinetic caption per clip, 2–5 words, appears **at the payoff** (A put
  captions ~1s in, near the _start_ — a real difference to reconcile).
- Silent-first / autoplay-muted design target.

**This submitter's asks for eng are close to what our pipeline already does,
just via a different mechanism worth calling out explicitly in the merge
pass:** we already have a deterministic `/demo/marketing-video` fixture route
with frozen data and no live network calls (their "demo/seed mode" +
`?demo=1` ask) and scriptable presence cursors (`CursorTimeline` in
`timeline.ts`, already used in `boards.ts`/`multiplayer.ts`) — ours are
React-rendered against real components on a virtual clock rather than
Playwright-injected DOM overlays against a live app. The `data-testid` ask is
the one gap: our scenes mostly select by class/role/text, which has already
caused calibration pain this session (multiple scenes needed pixel
recalibration after guessing a card's on-screen position). Worth raising with
eng regardless of which pipeline wins.

### 10 snippets

| #   | Name              | Len | Overlap w/ existing / batch 1                            | Notes                                                                                                                                                                                                                                                                                                    |
| --- | ----------------- | --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | Summon from Slack | 12s | **High** — `gateway` scene, batch-1 #8                   | Third independent pitch of the same idea. This version: split-screen, board card fades/scales in as Slack reply lands _simultaneously_ (vs. our sequential beats, vs. batch-1's cut/wipe transition).                                                                                                    |
| 02  | The Canvas        | 8s  | **High** — WIDE establishing shots, `boards`, batch-1 #4 | Third independent pitch of the pure-zoom-out idea. All three (ours, A's #4, B's #02) are basically the same shot.                                                                                                                                                                                        |
| 03  | Spin up a branch  | 8s  | **Medium** — batch-1 #1                                  | Same core idea as A's #1 (empty canvas → new branch → typed name → card lands), no button-origin animation detail in A's version. Neither built by us yet — genuinely open.                                                                                                                              |
| 04  | Give it a task    | 12s | **High** — `session`/`sessions` scenes                   | Prompt → thinking → tool-call steps (Read → Edit) → diff preview is almost exactly our existing `session` scene's phase structure. Adds a collapsible-steps UI treatment we don't have.                                                                                                                  |
| 05  | Fan out           | 15s | **High** — `multiAgentRace`, batch-1 #3                  | Third pitch of "parallel agents." Treatment differs from both: cards **deal out like a card deck** from one source card (vs. our one-card-4-sessions, vs. A's fan-arc-from-orchestrator). Three genuinely different edits of the same idea.                                                              |
| 06  | Fork the approach | 10s | **High** — `genealogyTree`, batch-1 #2                   | Third pitch of fork/genealogy. Distinct detail: explicitly a **node-link graph view** (parent node splits into two child nodes) — different from our BranchSessionSections indented-tree list. Worth checking if Agor has an actual graph view anywhere, or if this assumes a UI that doesn't exist yet. |
| 07  | Knowledge base    | 12s | **None**                                                 | Genuinely novel — first mention of Agor's Knowledge feature (search, `agor://` links, graph view) across both batches. We haven't touched Knowledge in any scene.                                                                                                                                        |
| 08  | Live artifact     | 12s | **Medium** — `artifact`, `leaderboard`, batch-1 #5       | Adds the most compelling net-new detail of any artifact pitch: clicking a **real control in the live app** (a dark-mode toggle it just built) and watching it actually respond, plus a code↔running-app split view.                                                                                      |
| 09  | Ship a PR         | 10s | **Medium** — batch-1 #6                                  | Same idea as A's #6, converges independently. Neither built by us. Genuinely open — two submitters, one instinct.                                                                                                                                                                                        |
| 10  | Multiplayer       | 8s  | **High** — `multiplayer` scene, batch-1 #7               | Third pitch of presence/multiplayer, most redundant item across all sources so far.                                                                                                                                                                                                                      |

### Submitter's own suggestions

- Sizzle order: 02 → 01 → 04 → 05 → 08 → 09 → 10 (canvas → Slack → task →
  fan-out → artifact → PR → multiplayer → end card). Differs from A's
  1→3→4→5→10 order but both lead with an establishing/hook shot and climax
  on the fan-out clip.
- Hold 05 (Fan out) and 08 (Live artifact) longest — "the differentiators."
- 03/06/07 called out as good standalone social posts, optional in the montage.
- Same "production asks for eng" instinct as noted above (data-testid hooks,
  seed/demo mode, scriptable presence cursors, a `?demo=1` flag).

---

## Batch 3 (submitter C)

No separate global production spec this time — just per-clip notes (folded
into the cross-batch spec comparison below). Framed explicitly against GTM
differentiation: "multiplayer canvas, parallel agents on worktrees, MCP
self-orchestration, persistent Slack teammate" — i.e. an instruction to
avoid generic screen-recording filler, not just a shot list.

### 9 snippets

| #   | Name                                       | Len | Overlap w/ existing / batches 1-2                                   | Notes                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------ | --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | One Canvas, Many Agents                    | 12s | **High** — WIDE shots/`boards`, batch-1 #4, batch-2 #02             | 4th independent pitch of the zoom-out-canvas idea. Novel detail: hovering a card pops a mini-preview tooltip with live diff/log lines — none of the other 3 versions do a hover-preview.                                                                                                                                                                                 |
| 2   | Prompt → Running Agent                     | 10s | **High** — batch-1 #1, batch-2 #03                                  | 3rd pitch of the spawn/create flow. All three (A#1, B#03, C#2) are close variations of empty canvas → new branch → typed prompt → card appears. Still nothing built by us.                                                                                                                                                                                               |
| 3   | Isolated Worktrees, Zero Collisions        | 10s | **Low** — batch-1 #6, batch-2 #09 (adjacent, not the same beat)     | Distinct emphasis from the PR clips: two branch cards, side-by-side diffs, proving no file conflicts. About _isolation_, not _shipping_. Genuinely underserved angle — worktree isolation is one of Agor's real differentiators and no prior pitch showed it this directly.                                                                                              |
| 4   | Agents Orchestrating Agents                | 14s | **Medium** — batch-1 #10 (same core idea)                           | 2nd pitch of the MCP-orchestrator angle (batch 2 skipped it). Concrete novel detail: highlighting the actual rendered MCP tool-call block (`agor_branches_create`) inline in the transcript — a specific, buildable UI element neither other pitch named.                                                                                                                |
| 5   | A Teammate That Lives in Slack             | 12s | **High** — `gateway` scene, batch-1 #8, batch-2 #01                 | 4th pitch of Slack-summon. Distinct emphasis: same avatar/name shown in both Slack and canvas — selling _identity continuity_, not just message routing.                                                                                                                                                                                                                 |
| 6   | Kanban That Runs Itself                    | 8s  | **High** — `zoneDrop`/`boards`, our skipped kanban idea, batch-1 #9 | 3rd pitch of kanban-drag, but shares a specific detail with batch-1 #9: a card auto-advancing zones _without_ a cursor drag (agent-driven, not human-driven). Two independent submitters landed on this exact "the board moves itself" beat — stronger signal than most other overlaps.                                                                                  |
| 7   | See the App, Not Just the Diff             | 10s | **High** — `artifact`/`leaderboard`, batch-1 #5, batch-2 #08        | 4th pitch of live-artifact. Novel detail: a DOM-inspector-style overlay highlighting an element on hover — not in any other pitch.                                                                                                                                                                                                                                       |
| 8   | Branch the Conversation, Not Just the Code | 10s | **High** — `genealogyTree`, batch-1 #2, batch-2 #06                 | 4th pitch of fork/genealogy. Tree treatment (dotted line to parent, small 2-3-node tree on zoom-out) is closer to our actual BranchSessionSections indented-tree implementation than batch-2's node-link-graph pitch.                                                                                                                                                    |
| 9   | Set It and Forget It                       | 8s  | **We already built this** — `scheduleFiring`                        | First and only schedule/cron pitch across all 3 batches — and we built almost exactly this (branch card → "Scheduled Runs" section, cron-fired session) before ever seeing it. Good independent validation. Novel detail we didn't do: a timelapse-style before/after cut showing a _previous_ run's timestamp change, vs. our single static "currently running" moment. |

### Submitter's own notes

- Cursor moves: ease-in-out, ~400-600ms per move (between A's 600-800ms and
  B's 350-500ms — all three cluster in the same "smooth, not snappy" range).
- Typing: ~40-60ms/char real per-character typing, explicitly _not_ paste-in
  — "someone's actually driving this" (same instinct as A's jitter and B's
  `pressSequentially`).
- Every clip: 1-2s hold + caption at the end, works muted.
- Offered to turn any one clip into an actual Playwright script skeleton —
  open offer, not started.
- **Also flagged, in the same message:** worth building a Skill capturing
  how we do this booth-loop pipeline so future batches get made consistently
  — noted below, not acted on yet (better written _after_ the decisions
  below are actually made, so it documents the real chosen approach rather
  than getting rewritten immediately).

---

## Cross-batch signal — all 3 batches in

**Convergence count** (how many of {ours, A, B, C} independently pitched
each idea):

| Idea                                   | Ours                | A   | B   | C             | Total   |
| -------------------------------------- | ------------------- | --- | --- | ------------- | ------- |
| Zoom-out canvas / establishing shot    | ✅                  | #4  | #02 | #1            | **4**   |
| Slack summon                           | ✅                  | #8  | #01 | #5            | **4**   |
| Fork / genealogy                       | ✅                  | #2  | #06 | #8            | **4**   |
| Live artifact                          | ✅                  | #5  | #08 | #7            | **4**   |
| Fan-out / parallel agents              | ✅                  | #3  | #05 | —             | **3**   |
| Multiplayer presence                   | ✅                  | #7  | #10 | —             | **3**   |
| Spawn/create branch flow               | —                   | #1  | #03 | #2            | **3**   |
| Worktree → PR                          | —                   | #6  | #09 | (#3 adjacent) | **2-3** |
| Kanban / self-advancing board          | —                   | #9  | —   | #6            | **2**   |
| Agents orchestrating agents (MCP meta) | —                   | #10 | —   | #4            | **2**   |
| Schedule / cron                        | ✅ `scheduleFiring` | —   | —   | #9            | **2**   |
| Knowledge base                         | —                   | —   | #07 | —             | **1**   |
| Worktree isolation (no PR)             | —                   | —   | —   | #3            | **1**   |

**Reading this:**

- The 4 ideas every single source (ours + all 3 submitters) converged on —
  zoom-out canvas, Slack summon, fork/genealogy, live artifact — are exactly
  our first 7 site scenes' territory (`boards`, `gateway`, and `artifact`)
  plus `genealogyTree`. Total consensus, already built. The open question is
  only whether any submitter's _treatment_ (hover-preview tooltips, DOM
  inspector overlay, node-link graph, identity-continuity framing) is worth
  a second pass on an existing scene rather than a new one.
- **Spawn/create branch flow** (3/3 submitters, 0/us) is the single biggest
  gap: every external pitch included it, we have nothing. Likely the
  highest-value next build.
- **Worktree isolation and PR-shipping** cluster together (2-3 pitches, 0
  built) — genuinely differentiated Agor territory per the GTM framing
  batch 3 cited, and unbuilt.
- **Schedule/cron** (2/4 — us + C) is a case where we independently arrived
  at the same idea as an external submitter before seeing their pitch —
  worth noting as a sanity check that our idea-generation is on the right
  track.
- **Knowledge base** (1/4, batch 2 only) remains the sole fully blue-ocean
  idea across 28 total pitches (9 batch 1 + 10 batch 2 + 9 batch 3).
- Multiplayer, fan-out, and kanban (2-3 pitches each, already built by us in
  some form) are solidly "keep what we have" — no submitter's treatment
  adds enough to justify a re-shoot.

**Production spec convergence:** all three submitters independently landed
on close variants of the same spec — 1920×1080 @2x DPI, 60fps→30fps
delivery, eased synthetic-cursor movement in the 350-800ms range, real
per-character typing at roughly 20-30 (or 40-60ms/char, same range) chars/
sec, and a held head/tail frame with a caption on the payoff. Three
independent authors converging this tightly reads as an industry-standard
demo-capture playbook, not personal taste — but it's still a materially
different pipeline from ours: theirs scripts Playwright against a live (or
`?demo=1`-flagged) running app with an injected cursor overlay and a
compositing/caption layer; ours renders real React components against
fixture data on a virtual clock with everything (camera, cursor, typing,
actions) authored directly in `timeline.ts` Tracks. Adopting their approach
wholesale would mean rebuilding the capture pipeline, not just tweaking
scene content.

## Decisions made

1. **Net-new ideas:** built all three (`newBranch`, `worktreePr`, `knowledge`) — see above.
2. **Pipeline:** staying on the React/fixture/virtual-clock approach, Evan's
   call ("don't worry about Playwright... you do it how you see fit") — the
   submitters' live-app + injected-cursor + compositor approach is not being
   adopted. No rebuild.
3. **Resolutions:** website (1600×900, matches the existing showcase carousel
   embed) + 1080p + 4K for conference-TV displays, all three for every
   booth-loop scene going forward (see `encode.sh --booth`).
4. **The Skill:** still queued, deliberately, until the enrichment pass below
   either happens or is explicitly deferred — so it documents the actually-
   final set of conventions rather than getting rewritten immediately after.

## Post-review rework — scheduleFiring and genealogyTree

Evan's review of the first interaction-addition pass caught two real
problems the pixel-diff self-review missed:

- **`scheduleFiring`'s spinner was still frozen** despite the fix "landing" —
  root cause was a real production bug, not a demo-only issue: the
  Scheduled Runs row's `<button>` in `BranchSessionSections.tsx` never set
  `data-session-id` (the other two session-row renderers — the flat list and
  the genealogy tree — both do). Our selector matched zero elements. Fixed
  by adding the missing attribute (matches the existing convention exactly;
  `BranchSessionSections.test.tsx`'s 14 tests still pass). Verified this
  class of bug can silently survive a single-frame pixel-diff: single-frame
  jumps skip the `ActionRunner`'s replay, so a "frozen" comparison there
  proves nothing — the real check is scripting `window.__agorDemo.setTime()`
  forward in order (matching capture.mjs) and reading the DOM's actual
  `.style.transform`, not diffing screenshots.
- **Neither `scheduleFiring` nor `genealogyTree` showed the real feature.**
  scheduleFiring's card only showed a running session in a list — never the
  actual cron settings. genealogyTree's cursor pointed at tree rows but
  nothing opened, so the video didn't explain _how_ a fork happens. Both
  rebuilt to mount real product UI, same "real inner components, custom
  outer chrome" pattern as Marketplace/Knowledge:
  - `scheduleFiring` now opens the REAL `ScheduleTab.tsx` (BranchModal's
    schedule list) over the board: name, humanized cron ("At 02:00"), raw
    cron expression, next/last run, enabled toggle — then a real cursor
    clicks the real "Run now" button, which fires the actual handler
    (loading state, `schedules/{id}/run-now` call, success toast). New
    `DemoScheduleStage.tsx` + `demoScheduleData.ts` + `demoScheduleClient.ts`.
    **Known limitation:** the success toast is real but its antd
    `message.success` duration is a real-wall-clock timer, decoupled from
    the scene's virtual clock — capture.mjs takes roughly 1s of real time
    per virtual frame, so by the next captured frame the toast has usually
    already auto-dismissed on the real clock even though the virtual
    timeline barely moved. The click and its loading state are still real;
    the toast just isn't reliably visible in the rendered video.
  - `genealogyTree` now opens the REAL `ForkSpawnModal` (`action="fork"`)
    on the tree's actual fork edge (session-2 "reproduce with a stress
    test" forking into session-3 "patch the race with a mutex"), with a
    real prompt typed into its real textarea. Deliberately uses `fork`, not
    `spawn`: the real product's Fork flow has no agent picker (only Spawn
    does, via `AgentSelectionGrid`), so "opening a session and forking it
    with another agent" doesn't match how the feature actually works — the
    accurate version is: same agent, a typed prompt describing the
    alternative approach. No new stub client needed since `client={null}`
    is already a safe, handled path in `AutocompleteTextarea`.

Both scenes recaptured, re-encoded (showcase + 1080p + 4K), and verified
frame-by-frame (typed prompt fully legible, spinner rotation confirmed via
isolated-region diff between two camera-and-cursor-static frames, no HMR
contamination).

## Open decision — live-site frozen-spinner bug

The same `token.motion=false`/frozen-`<Spin>` bug fixed in the booth-loop
scenes (see "Interaction-addition pass" above) is also present in the two
**published website scenes** `boards.ts` and `multiplayer.ts` (both feature
multiplayer-presence's RUNNING Codex session with a static spinner). Flagged
to Evan; fixing it means editing and republishing the public site's
hero/carousel videos, which is out of scope without an explicit go-ahead —
not done, no decision requested or given yet.

## Enrichment candidates (additive details for scenes we already have)

Evan's ask: mine the 3 batches for details that would make an _existing_
scene better, not just fill gaps. Roughly ordered by effort; struck-through
items are now built (see "Interaction-addition pass" above).

**Low effort (reuses mechanisms already proven this session):**

- ~~_Self-advancing kanban card_~~ — **built as `autoAdvance`.** (batch 1 #9
  - batch 3 #6, independently matched detail): a card moves zones with no
    cursor at all, via the same `nodePlacements` position-Track mechanism used
    everywhere else, just without a cursor beat driving it.
- _Identity-continuity framing for Slack_ (batch 3 #5's detail): same
  avatar/name shown in both the Slack pane and the board card. `gateway`
  already stages both; would just need the same demo user's avatar visible
  in both panels at once, which may already be true — **still not checked**,
  a screenshot-only verification, no code, if picked up.

**Medium effort (needs a small new visual, no new data-fetching):**

- ~~_Hover-preview tooltip on a card_~~ — **built as `canvasHoverPreview`.**
  (batch 1 #1, batch 2 #02, batch 3 #1 — 4-way convergence on the
  zoom-out-canvas idea, this was the one differentiating detail among them):
  a real cursor hovers two cards in the wide shot, each popping a small
  tooltip with live-looking diff/log lines.
- _DOM-inspector-style hover overlay on a live artifact_ (batch 3 #7): a
  bounding-box highlight + label on hover, would enhance `artifact` or
  `leaderboard`. New small overlay component, positioned via
  `getBoundingClientRect()` on the target element — mechanically similar to
  the bounding-box idea batch 1's spotlight-effect proposal used, but scoped
  to one element instead of a whole captioning system.

**Blocked / needs a pipeline extension:**

- _Click a real control inside a live Sandpack artifact and watch it respond_
  (batch 2 #08's stand-out detail — a dark-mode toggle actually flipping).
  Sandpack's iframe is cross-origin, so `document.querySelector` from a
  scene's `actions` (today's mechanism — a `page.evaluate` callback) can't
  reach into it. A _real_ trusted click at a screen (x, y) — e.g.
  `page.mouse.click()` — would still land on the iframe correctly regardless
  of origin, but that's a Playwright-side capability our `actions` array
  doesn't expose today (`run: () => void` executes inside the page, not from
  Node). Would need a new `ActionKeyframe` variant capture.mjs treats
  specially. Not attempted this session.
