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

**Merge rule:**

- **MCP recs** = union of both goals' lists, deduped, capped at **4 shown**.
- **Bootstrap prompt** = both goals' bootstrap lines concatenated, plus one bridging instruction:

  > They picked two goals — don't run both playbooks at once. Ask which matters more right now,
  > lead with that one, and mention you can help with the other once the first win lands.

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
- [ ] Two-goal merge follows the rule: deduped union capped at 4, concatenated bootstrap lines + the bridging instruction.
- [ ] Card/bootstrap copy names concrete artifacts, stays plain and second-person, and avoids hedging adjectives.
- [ ] Card 1's inbox/news promise is backed by a real connector or the copy was adjusted; the gap is flagged in the PR.
