# Onboarding Design: Goal Over Role

**The onboarding wizard's first question is what you want AI to do for you — not who you are.**

This is the house decision for the onboarding wizard
([`OnboardingWizard.tsx`](../../apps/agor-ui/src/components/OnboardingWizard/OnboardingWizard.tsx),
personas in [`onboardingPersonas.ts`](../../apps/agor-ui/src/utils/onboardingPersonas.ts)).
It replaces the shipped role/persona framing. Read it before touching that surface —
it's the fixed reference so the implementation isn't re-derived from scattered chat and KB docs.

The step's badge label in `OnboardingWizard.tsx` must change from **"You"** to **"Goals"**. "You"
encoded the old "who are you" framing; "Goals" matches both the new framing and the one-word style
of the other step labels (e.g. "Workspace").

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

## The four goal cards (locked copy)

These went through several rounds of copywriting. **Do not rewrite them.** The one exception on
record: card 1's noun was changed from "assistant" to "teammate" per an explicit resolved decision
(see "Resolved: it's 'teammate'" below) — a one-word correction to match the product noun, not an
ad hoc rewrite. The "locked copy" rule still holds for everything else.

| # | Card | Description |
| - | ---- | ----------- |
| 1 | 🔍 **Finally, a personal teammate** | Reads your inbox, Slack, and news so you don't have to. |
| 2 | ✍️ **Never chase a status update again** | Meeting notes, action items, and project updates — drafted for you. |
| 3 | 🛠️ **Ship without the busywork** | PRs, bug triage, release notes — handled. |
| 4 | 👥 **Give your team an AI teammate** | One helper who knows everyone's Slack, docs, and boards — not just yours. |

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

1. **MCP recs** — a short list of integration recommendations.
2. **Bootstrap line** — one line of guidance telling the first AI teammate what this user wants
   and how to open the conversation.

When a user picks two goals, **merge the two blocks with one shared rule** — never write bespoke
copy per combination. There are 10 possible 1-or-2-goal combinations; hardcoding them all is the
"persona explosion" failure mode this redesign exists to avoid.

Selection order matters: the **first-picked** goal is the **primary**, the second is the
**secondary**. Both merges below lean on that ordering. The implementation must therefore hold
selections in an **order-preserving array** (append on select, splice on deselect) — not a `Set` or
any unordered structure, which would silently break "first-picked = primary."

**MCP-rec merge** — the union routinely exceeds 4 (e.g. goal 2 + goal 4 = 6 unique), so "cap at 4"
must say *which* 4 survive. Build the list of **4 shown** in this exact order:

1. Take the first **2** recs from the **primary** goal's list (in the order listed).
2. Append the first **2** recs from the **secondary** goal's list (in the order listed).
3. **Dedup** against what's already included — drop any that repeat.
4. If dedup left fewer than 4, **refill** from the **primary** goal's remaining recs (in order),
   then the secondary's, until you reach 4 or both lists are exhausted.

**Bootstrap-prompt merge** — concatenate both goals' bootstrap lines, then append this bridging
instruction. The user already told you both goals by picking both cards, so **don't reopen with a
clarifying question** — lead with action:

  > Treat the first-picked goal as primary. Open the first message with a concrete action on it —
  > not a question. Once that first win is delivered or clearly underway, proactively mention the
  > second goal: "…and once that's working, I can also help with [secondary goal's outcome]."

**Skip / 0 goals** — the step is skippable, so cover the empty case. When the user selects no goals,
fall back to a **generic default block** — the same spirit as the existing
`PERSONA_MCP_RECS['_default']` fallback already in the codebase: **no goal-specific bias** in the MCP
recs, and a generic bootstrap line that follows the user rather than assuming a goal (along the lines
of "ask what they're working on right now and follow their lead"). This completes the 0 / 1 / 2-goal
coverage.

### Per-goal blocks (reference)

| Goal | MCP recs | Bootstrap line |
| ---- | -------- | -------------- |
| Finally, a personal teammate | Slack, + existing web-search / knowledge-base tools (no email/news connector yet — see gap) | Wants a daily brief across scattered sources. Ask what's overwhelming them most (Slack, industry news) and propose a recurring digest as the first win. |
| Never chase a status update again | Linear, Shortcut/Jira, Slack, Calendar | Drowning in status-chasing. Ask about their current project or last meeting, offer to draft the recap + action items as the first win. |
| Ship without the busywork | GitHub, Sentry, Datadog | Wants execution handled. Ask which repo, offer to scan open issues/PRs for a quick win. |
| Give your team an AI teammate | Slack, HubSpot, Linear, Datadog | Wants a shared teammate for the team. Ask what the team repeats manually across people, propose seeding a shared teammate onto the team board. |

---

## Brand voice for this surface

Copy on these cards and in bootstrap lines follows three rules:

- **Name a concrete artifact/outcome, not an abstract capability.** "Meeting notes, action items"
  beats "collaborate more effectively."
- **Personal, plain, first-person-relatable register.** No corporate/governance jargon —
  "broadcast outcomes, surface blockers" is the anti-pattern.
- **Second person, short lines, no hedging adjectives.** Drop "robust", "seamless", "powerful".

The canonical source for user-facing voice is the Agor team Knowledge base doc
`marketing/messaging-and-positioning.md` ("Agor — Messaging & Positioning (v2 draft)"), which
CLAUDE.md names as the source of truth for this repo's copy. The rules above are consistent with it;
the cross-checks below reconcile the three places this surface touches that doc.

### Resolved: it's "teammate"

Max decided the product noun is **"teammate"**, not "assistant". Card 1 was updated accordingly,
from "Finally, a personal **assistant**" to "Finally, a personal **teammate**", so the wizard is
consistent throughout. This reconciles the messaging doc's older "assistant" language (2026-06-21)
with the later `product/assistant-to-teammate-rename-audit.md` decision (2026-07-07) and the
wizard's existing "AI teammate" copy ("Name your AI teammate", the `teammateName` step in
`seedOnboardingTeammate.ts`) — "teammate" wins across the board.

### Two persona systems — don't conflate them

The messaging doc has its own **"Personas & use-cases"** section defining four **GTM/marketing
audience personas** (AI enabler, orchestrator/builder EPD, team-that-learns-together, Slack-native
business user). Those are a **top-of-funnel marketing** segmentation — a different system for a
different purpose than the four **onboarding goal cards** in this guideline, which are **first-day,
in-product outcome selection**. They are not a renaming of each other and must not be mapped 1:1;
keep the two systems separate when editing either.

### Banned-jargon compliance

The messaging doc's appendix reserves technical nouns — **"git branches", "sessions", "isolation
modes"** — for the technical/reference tier only. Checked: **none of the four card headlines or
subtexts use any of them.** Future editors should keep it that way — this bar was verified, not
assumed.

---

## Known gap: card 1 promises connectors that don't exist

Card 1 ("Finally, a personal teammate") promises reading your **inbox and news**, but there is
**no email or news-source MCP connector in the codebase today**. Existing integrations are Slack,
GitHub, HubSpot, Linear, Sentry, Datadog, Figma, Stripe, and Amplitude.

**Open follow-up — do not silently build a fake capability.** Before card 1's promise ships,
either land a real email/news connector or adjust the copy to match what actually connects. Flag
this in the implementation PR.

---

## Review checklist

- [ ] First question asks goal/outcome, not role/job title.
- [ ] The step badge label is "Goals", not "You".
- [ ] The four card titles and descriptions match the locked copy exactly.
- [ ] Selection is multi-select capped at 2, and the step is still skippable.
- [ ] Selections stored in `preferences.onboarding.goals: string[]` (order-preserving, max 2); legacy `persona` left untouched and not migrated.
- [ ] Selection state is an order-preserving array (append/splice), not a `Set`, so first-picked = primary holds.
- [ ] Each goal is a reusable block (MCP recs + one bootstrap line) — no per-combination copy.
- [ ] Two-goal MCP recs follow the ordered 4-slot rule (2 primary, 2 secondary, dedup, refill from primary).
- [ ] Two-goal bootstrap leads with a concrete action on the primary goal — no clarifying question — and surfaces the secondary only after the first win.
- [ ] Skip / 0-goal path falls back to a generic default block (no goal bias, follow-the-user bootstrap line); 0/1/2-goal cases all covered.
- [ ] Card/bootstrap copy names concrete artifacts, stays plain and second-person, and avoids hedging adjectives.
- [ ] No card headline/subtext uses reserved technical jargon ("git branches", "sessions", "isolation modes").
- [ ] Card 1 says "personal teammate" (not "assistant"), consistent with the wizard's "teammate" product noun.
- [ ] Card 1's inbox/news promise is backed by a real connector or the copy was adjusted; the gap is flagged in the PR.
