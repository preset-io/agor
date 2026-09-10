# Onboarding Design: Goal Over Role

**The onboarding wizard's first question is what you want AI to do for you — not who you are.**

This is the house decision for the onboarding wizard
([`OnboardingWizard.tsx`](../../apps/agor-ui/src/components/OnboardingWizard/OnboardingWizard.tsx),
goals in [`onboardingGoals.ts`](../../apps/agor-ui/src/utils/onboardingGoals.ts)).
It replaces the shipped role/persona framing. Read it before touching that surface —
it's the fixed reference so the implementation isn't re-derived from scattered chat and KB docs.

The step's badge label is **"Goals"**, not **"You"**. "You" encoded the old "who are you"
framing; "Goals" matches both the new framing and the one-word style of the other step labels.

---

## The principle

Ask **goal/outcome** ("what do you want done"), not **role/identity** ("who are you" / job title).

- Goals cut across job titles more cleanly than roles do. Someone who is both a PM and a
  team lead is one person with several goals, not one box to pick.
- Role single-select forces hybrid users into an identity they don't fully fit. User research
  (tester interviews) surfaced this directly.
- A hardcoded persona → recommendation map with no visible logic reads as opaque ("how does it
  know what's best for me?", [agor#1956](https://github.com/preset-io/agor/issues/1956)). Goal
  cards make the reasoning legible: you asked for X, so we suggest the tools for X.

The old model keyed a single persona into a hardcoded `PERSONA_MCP_RECS` map and a bootstrap
prompt. Don't carry that framing forward.

---

## The six goal cards (locked copy)

These went through several rounds of copywriting. **Do not rewrite them.** Card 1 has two recorded
exceptions: its noun changed from "assistant" to "teammate" to match the product noun, and its
description changed from an unsupported inbox/news promise to Slack and recurring updates (see the
resolved capability note below). The "locked copy" rule still holds for everything else.

**House test for titles:** each title must name a concrete outcome in language a user would say,
not a job title or an abstract capability. Keep it short enough to scan as a card heading.

| #   | Card                          | Description                                      |
| --- | ----------------------------- | ------------------------------------------------ |
| 1   | **Get a personal teammate**   | Keeps up with Slack so you don’t have to.        |
| 2   | **Never chase an update**     | Meeting notes and status, drafted for you.       |
| 3   | **Ship without the busywork** | PRs, bug triage, and release notes, all handled. |
| 4   | **A teammate for the team**   | Knows the whole team's Slack, docs, and boards.  |
| 5   | **Build me an app**           | A working app or dashboard on a live test env.   |
| 6   | **Dig into anything**         | Ask a question, get real research back.          |

---

## Selection: multi-select, skippable

- Users pick **up to 2** goals. Do **not** force exactly one.
- The step stays **skippable**, per the wizard's existing skippable-step convention.
- Two goals is the cap. More than that dilutes the first-win focus the bootstrap prompt depends on.

---

## Data model

The old wizard writes a single string to `user.preferences.onboarding.persona`
(`developer` / `pm` / `lead` / `solo`) via `saveOnboardingProgress({ persona })` and threads it into
the teammate-creation payload. Multi-select needs array storage, and existing users already carry
the old string shape.

- **New field.** Store goal selections in `preferences.onboarding.goals: string[]` — goal-card ids,
  order-preserving, max 2. The primary/secondary distinction the merge rules depend on lives in this
  array's order (see "Composable blocks").
- **Leave `persona` untouched.** Do **not** migrate, reinterpret, or backfill the legacy
  `persona: string`. There is no clean mapping from the old role values to the new goal ids, so don't
  invent one — keep old stored values as a historical record only.
- **No migration needed for existing users.** A user who onboarded under the old wizard simply has no
  `goals` value. That's fine: `goals` is read **once**, at that user's own onboarding completion, to
  seed their first teammate — it is never re-read later to change ongoing behavior, so an absent value
  has no downstream effect.

---

## Composable blocks, not per-combination scripts

Each goal is a small reusable **block** with two parts:

1. **Tool/connection recs** — a short list whose entries name their real setup surface
   (Catalog, Settings → MCP Servers, or an already-connected Agor repository).
2. **Bootstrap guidance** — the desired outcome plus a concrete first win. The shared prompt owns
   the only opening strategy, so goal blocks never introduce competing ask-vs-act instructions.

When a user picks two goals, **merge the two blocks with one shared rule** — never write bespoke
copy per combination. With six goals capped at two picks there are **21** possible selections
(15 pairs + 6 singles); hardcoding them all is the "persona explosion" failure mode this redesign
exists to avoid — and the argument only gets stronger as the goal set grows.

Selection order matters: the **first-picked** goal is the **primary**, the second is the
**secondary**. Both merges below lean on that ordering. The implementation must therefore hold
selections in an **order-preserving array** (append on select, splice on deselect) — not a `Set` or
any unordered structure, which would silently break "first-picked = primary."

**Recommendation merge** — the union routinely exceeds 4 (e.g. goal 2 + goal 4 = 6 unique), so "cap at 4"
must say _which_ 4 survive. Build the list of **4 shown** in this exact order:

1. Take the first **2** recs from the **primary** goal's list (in the order listed).
2. Append the first **2** recs from the **secondary** goal's list (in the order listed).
3. **Dedup** against what's already included — drop any that repeat.
4. If dedup left fewer than 4, **refill** from the **primary** goal's remaining recs (in order),
   then the secondary's, until you reach 4 or both lists are exhausted.

**Bootstrap-prompt composition** — render one canonical opening, rather than concatenating two
competing opening instructions:

1. Treat the first-picked goal as primary and include its desired outcome and first win.
2. If live context is sufficient, perform one concrete first-win action immediately and report the
   result. If essential context is missing, ask exactly one specific question and act on the answer.
   Do not conduct an interview.
3. For two goals, include the secondary goal's outcome and first win, but keep the first goal
   primary until its first win is delivered or clearly underway. Offer the secondary goal next;
   never ask the user which selected goal matters more.

This makes selection order executable: one primary determines the first win, while the secondary
is acknowledged without competing for the opening. For a single goal, apply steps 1–2 and omit the
bridge.

**Skip / 0 goals** — the step is skippable, so cover the empty case. When the user selects no goals,
fall back to a **generic default block** — the same spirit as the old
`PERSONA_MCP_RECS['_default']` fallback: **no goal-specific bias** in the recommended
tools, and a generic bootstrap line that follows the user rather than assuming a goal (along the lines
of "ask what they're working on right now and follow their lead"). This completes the 0 / 1 / 2-goal
coverage.

### Per-goal blocks (reference)

| Goal                      | MCP recs                         | Desired outcome                                  | First win                                                                     |
| ------------------------- | -------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Get a personal teammate   | Slack                            | A useful recurring brief from connected sources. | A Slack digest based on the channels the user cares about.                    |
| Never chase an update     | Linear, Atlassian, Notion, Slack | Fewer status chases.                             | A draft recap and action list for the current project or latest meeting.      |
| Ship without the busywork | GitHub, Sentry, Datadog          | Less shipping busywork.                          | Scan the relevant repo for an actionable issue or pull request.               |
| A teammate for the team   | Slack, Notion, Linear, Datadog   | A shared teammate for repeated team work.        | Identify one repeated workflow to run from the team board.                    |
| Build me an app           | GitHub, Figma                    | A working build, not a spec.                     | Start the requested prototype, internal tool, or dashboard live on the board. |
| Dig into anything         | Amplitude, Firecrawl             | Active research on demand.                       | One evidence-backed finding about the competitor, market, or dataset.         |

---

## Brand voice for this surface

Copy on these cards and in bootstrap lines follows three rules:

- **Name a concrete artifact/outcome, not an abstract capability.** "Meeting notes, action items"
  beats "collaborate more effectively."
- **Personal, plain, first-person-relatable register.** No corporate/governance jargon —
  "broadcast outcomes, surface blockers" is the anti-pattern.
- **Second person, short lines, no hedging adjectives.** Drop "robust", "seamless", "powerful".

The canonical source for user-facing voice is the Agor team Knowledge base doc
`marketing/messaging-and-positioning.md` ("Agor — Messaging & Positioning"), which
CLAUDE.md names as the source of truth for this repo's copy. The rules above are consistent with it;
the cross-checks below reconcile the three places this surface touches that doc.

### "Teammate", not "assistant" — already-established terminology, not a new call

"Teammate" was already the product's established noun before this guideline — see the 2026-07-07
`product/assistant-to-teammate-rename-audit.md` and the wizard's existing "Name your AI teammate"
copy (the `teammateName` step in `seedOnboardingTeammate.ts`). Card 1's noun was corrected from
"assistant" to "teammate" (now "Get my own personal teammate") to match that existing terminology,
reconciling the messaging doc's older "assistant" language (2026-06-21). This isn't a new decision
needing Max's review — it's a consistency fix against what the product already calls itself
everywhere else.

### Two persona systems — don't conflate them

The messaging doc has its own **"Personas & use-cases"** section defining four **GTM/marketing
audience personas** (AI enabler, orchestrator/builder EPD, team-that-learns-together, Slack-native
business user). Those are a **top-of-funnel marketing** segmentation — a different system for a
different purpose than the six **onboarding goal cards** in this guideline, which are **first-day,
in-product outcome selection**. They are not a renaming of each other and must not be mapped 1:1;
keep the two systems separate when editing either.

### Banned-jargon compliance

The messaging doc's appendix reserves technical nouns — **"git branches", "sessions", "isolation
modes"** — for the technical/reference tier only. Checked: **none of the six card headlines or
subtexts use any of them.** Future editors should keep it that way — this bar was verified, not
assumed.

---

## Resolved capability alignment for card 1

Card 1 deliberately promises Slack and recurring updates rather than inbox/news access. Its first
win is a Slack digest, matching the integration the goal actually recommends. Do not reintroduce an
email or news promise until the product has a supported connector for it.

---

## Review checklist

- [ ] First question asks goal/outcome, not role/job title.
- [ ] The step badge label is "Goals", not "You".
- [ ] All six card titles and descriptions match the locked copy exactly.
- [ ] Every card title names a concrete outcome in the user's language.
- [ ] Selection is multi-select capped at 2, and the step is still skippable.
- [ ] Selections stored in `preferences.onboarding.goals: string[]` (order-preserving, max 2); legacy `persona` left untouched and not migrated.
- [ ] Selection state is an order-preserving array (append/splice), not a `Set`, so first-picked = primary holds.
- [ ] Each goal is a reusable block (routed tool/connection recs + desired outcome + first win) — no per-combination copy.
- [ ] Every recommendation names a real current setup surface; removed catalog entries are never sent to Catalog.
- [ ] Two-goal recommendations follow the ordered 4-slot rule (2 primary, 2 secondary, dedup, refill from primary).
- [ ] Bootstrap has one canonical ask-or-act strategy; it acts when context is sufficient and otherwise asks exactly one specific question.
- [ ] Two-goal bootstrap keeps the first selection primary and offers the secondary after the first win is delivered or underway; it never asks the user to reprioritize.
- [ ] Skip / 0-goal path falls back to a generic default block (no goal bias, follow-the-user bootstrap line); 0/1/2-goal cases all covered.
- [ ] Card/bootstrap copy names concrete artifacts, stays plain and second-person, and avoids hedging adjectives.
- [ ] No card headline/subtext uses reserved technical jargon ("git branches", "sessions", "isolation modes").
- [ ] Card 1 says "teammate" (not "assistant") — a copy-consistency check against the product's established noun, not a decision awaiting sign-off.
- [ ] Card 1 promises only supported Slack/recurring-update behavior unless a real email/news connector has landed.
