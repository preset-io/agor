# Onboarding Design: Goal Over Role

**The onboarding wizard's first question is what you want AI to do for you — not who you are.**

This is the house decision for the onboarding wizard
([`OnboardingWizard.tsx`](../../apps/agor-ui/src/components/OnboardingWizard/OnboardingWizard.tsx),
personas in [`onboardingPersonas.ts`](../../apps/agor-ui/src/utils/onboardingPersonas.ts)).
It replaces the shipped role/persona framing. Read it before touching that surface —
it's the fixed reference so the implementation isn't re-derived from scattered chat and KB docs.

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

These went through several rounds of copywriting. **Do not rewrite them.**

| # | Card | Description |
| - | ---- | ----------- |
| 1 | 🔍 **Finally, a personal assistant** | Reads your inbox, Slack, and news so you don't have to. |
| 2 | ✍️ **Never chase a status update again** | Meeting notes, action items, and project updates — drafted for you. |
| 3 | 🛠️ **Ship without the busywork** | PRs, bug triage, release notes — handled. |
| 4 | 👥 **Give your team an AI teammate** | One helper who knows everyone's Slack, docs, and boards — not just yours. |

---

## Selection: multi-select, skippable

- Users pick **up to 2** goals. Do **not** force exactly one.
- The step stays **skippable**, per the wizard's existing skippable-step convention.
- Two goals is the cap. More than that dilutes the first-win focus the bootstrap prompt depends on.

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
**secondary**. Both merges below lean on that ordering.

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

### Per-goal blocks (reference)

| Goal | MCP recs | Bootstrap line |
| ---- | -------- | -------------- |
| Finally, a personal assistant | Slack, + existing web-search / knowledge-base tools (no email/news connector yet — see gap) | Wants a daily brief across scattered sources. Ask what's overwhelming them most (Slack, industry news) and propose a recurring digest as the first win. |
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

### "Assistant" vs "teammate" — open naming question

The messaging doc (2026-06-21) leans on **"assistant"** for the entity name. A later decision doc,
`product/assistant-to-teammate-rename-audit.md` (2026-07-07), and the shipped wizard code both use
**"AI teammate"** ("Name your AI teammate", the `teammateName` step in `seedOnboardingTeammate.ts`).
So "teammate" is the current, more recent product noun, superseding the messaging doc's "assistant".

Card 1's locked title — "Finally, a **personal assistant**" — is the one place the wizard calls the
entity an "assistant" while everything else calls it a "teammate". **This is a real terminology
mismatch, flagged here as an open copy question for whoever owns the rename audit.** The card copy
was deliberately locked after several rounds of iteration, so **do not rewrite it here** — resolve
it with the copy owner before implementation, not silently in code.

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

Card 1 ("Finally, a personal assistant") promises reading your **inbox and news**, but there is
**no email or news-source MCP connector in the codebase today**. Existing integrations are Slack,
GitHub, HubSpot, Linear, Sentry, Datadog, Figma, Stripe, and Amplitude.

**Open follow-up — do not silently build a fake capability.** Before card 1's promise ships,
either land a real email/news connector or adjust the copy to match what actually connects. Flag
this in the implementation PR.

---

## Review checklist

- [ ] First question asks goal/outcome, not role/job title.
- [ ] The four card titles and descriptions match the locked copy exactly.
- [ ] Selection is multi-select capped at 2, and the step is still skippable.
- [ ] Each goal is a reusable block (MCP recs + one bootstrap line) — no per-combination copy.
- [ ] Two-goal MCP recs follow the ordered 4-slot rule (2 primary, 2 secondary, dedup, refill from primary).
- [ ] Two-goal bootstrap leads with a concrete action on the primary goal — no clarifying question — and surfaces the secondary only after the first win.
- [ ] Card/bootstrap copy names concrete artifacts, stays plain and second-person, and avoids hedging adjectives.
- [ ] No card headline/subtext uses reserved technical jargon ("git branches", "sessions", "isolation modes").
- [ ] The "assistant" (card 1) vs "teammate" (rest of wizard) naming question was raised with the copy owner, not silently rewritten.
- [ ] Card 1's inbox/news promise is backed by a real connector or the copy was adjusted; the gap is flagged in the PR.
