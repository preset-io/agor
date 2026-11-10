---
name: onboarding-findings
description: Maintain apps/agor-docs/demo-videos/e2e/ONBOARDING_FINDINGS.md — the running log of Agor onboarding bugs, workarounds, and friction discovered while building the demo-video syllabus.
---

# Onboarding findings log

`apps/agor-docs/demo-videos/e2e/ONBOARDING_FINDINGS.md` collects everything
the demo-video work surfaces about Agor's onboarding experience, for Evan to
triage with the team once the videos are done. It is explicitly NOT P0 —
log and move on; don't stop video work to fix product bugs unless asked.

## When to add an entry

- Any time a lesson/spec needs a **workaround for product behavior** (not
  for test flakiness), the workaround IS a finding — write it down in the
  same sitting, while the repro details are fresh.
- Anything a real new user would trip on, even if the suite sails past it
  (confusing empty states, misleading copy, silent failures, slow paths).
- Ecosystem limitations that affect Agor users (e.g. a CLI ignoring an env
  var) belong too, marked as observations.

## Entry format

Keep the existing file's shape:

- Numbered `##` sections, ordered by how much you'd want them fixed.
- Status emoji: 🐛 bug worth filing · 🔧 fixed on this branch, needs to
  land · 💡 UX/polish suggestion · 📝 observation / ecosystem limitation.
- Each entry: what happens, how it was hit **for real** (never
  hypothesized), the workaround if the suite carries one (with file
  pointer), and a concrete **Suggestion:** where one exists.
- Verify claims in code before asserting them (file:line for the cause
  when known). Don't overclaim — if pre-compaction details are gone, say
  "observation" and describe what was seen.
- Renumber later sections when inserting; keep the footer's repro-pointer
  paragraph current.

## Hygiene

- The file is repo-tracked on this branch so it travels with the suite;
  Evan may edit/trim before sharing — don't fight his edits.
- No secrets, no tokens, no personal data in entries.
- If a finding gets FIXED on the branch, flip it to 🔧 with the commit
  hash rather than deleting it — the history is the value.
