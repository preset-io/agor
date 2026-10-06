# Onboarding Design: Goal Over Role

**The onboarding wizard's first question is what you want AI to do for you — not who you are.**

House decision for the onboarding wizard
([`OnboardingWizard.tsx`](../../apps/agor-ui/src/components/OnboardingWizard/OnboardingWizard.tsx));
goal cards, recommendations, merge rules, and bootstrap lines live in
[`onboardingGoals.ts`](../../apps/agor-ui/src/utils/onboardingGoals.ts), which is the
source of truth for their data. Read this before changing that surface.

## Principle

Ask **goal/outcome**, not **role/identity**. Goals cut across job titles (a PM
who is also a lead has several goals, not one box), and goal cards make
recommendations legible — you asked for X, so here are the tools for X — where a
hidden persona → recommendation map read as opaque
([agor#1956](https://github.com/preset-io/agor/issues/1956)). Don't reintroduce
role/persona framing. The step badge is **"Goals"**.

## Goal cards

Card titles and descriptions in `ONBOARDING_GOALS` are **locked copy** — do not
rewrite them. New or changed titles must name a concrete outcome in words a user
would say (not a job title or abstract capability), short enough to scan.

Copy rules for cards and bootstrap lines:

- Name a concrete artifact/outcome ("meeting notes, action items"), not a
  capability ("collaborate more effectively").
- Plain, personal, second person, short lines; no corporate jargon or hedging
  adjectives ("robust", "seamless", "powerful").
- No reserved technical nouns ("git branches", "sessions", "isolation modes").
- The product noun is **teammate**, not "assistant".
- Promise only supported capabilities. Card 1 promises Slack and recurring
  updates; don't add an email/news promise until a supported connector exists.
- The canonical voice source is the KB doc `marketing/messaging-and-positioning.md`.
  Its GTM **audience personas** are a separate marketing segmentation — never
  map them 1:1 onto onboarding goal cards.

## Selection and storage

- Multi-select, **max 2** (`MAX_ONBOARDING_GOALS`); the step is skippable.
- Selection state is an **order-preserving array** (append on select, splice on
  deselect), never a `Set`: first-picked is primary, second is secondary.
- Stored as `preferences.onboarding.goals: string[]` (goal ids, ordered;
  `[]` when skipped). It is read once, at onboarding completion, to seed the
  first teammate — never to drive ongoing behavior.
- Leave the legacy `preferences.onboarding.persona` string untouched: no
  migration, reinterpretation, or backfill (no clean mapping exists).

## Composable blocks

Each goal is a reusable block: ordered tool/connection recs plus a bootstrap
line (desired outcome + first win). Combine blocks with shared rules; never
write per-combination copy (21 possible selections is the "persona explosion"
this design avoids).

**Recommendations** (`mergeGoalIntegrationRecs`): up to 4 Connect items, then
Ask-the-teammate extras (Slack) appended separately and never counted against
the cap. For two goals: first 2 from primary, first 2 from secondary, dedup,
then refill from primary's remainder, then secondary's. Zero goals use the
unbiased default set. Every rec names its real setup surface (Catalog entry,
Slack gateway, or connected repository); never route a removed catalog entry to
Catalog. All suggestions are deselectable.

**Bootstrap** (`buildGoalBootstrapGuidance`): the shared prompt owns the one
opening strategy — act on a concrete first win if context suffices, otherwise ask
exactly one specific question; no interviews. Goal lines describe outcomes and
wins only and never add competing ask-vs-act instructions. With two goals, the
primary stays primary until its first win is delivered or underway, then the
secondary is offered; never ask the user which matters more. Zero goals: follow
the user's lead without assuming a goal.

## Tools step and in-context Catalog

- Suggestions are separate from connections. Skip suppresses bootstrap
  suggestions, not saved connections; Back/Skip never delete connections.
- **Sign in through Catalog** opens the existing `CatalogTab` /
  `CatalogDetailDrawer` (shared `CatalogDrawer` presentation seam) with an
  explicit `context.mode: 'onboarding'` — no pathname detection, spacing
  overrides, second auth API/state machine, restored obsolete routes, or
  completing onboarding just to open a drawer. Onboarding renders only the
  drawers, not an empty Catalog grid.
- Catalog owns consent, readiness, policy, secure token input, the OAuth popup,
  and durable attempt + caller-scoped credential confirmation. Installation is
  not proof of OAuth success; unconfirmed OAuth can be retried or deferred.
- Browsing creates nothing; Connect is install-only (no board, branch, or
  session). In onboarding, no tryout teammates, session actions, tryouts, or
  starter prompts — ready connections offer **Return to onboarding**.
- Cancellation erases private input; owner/generation replacement fences stale
  continuations. Only confirmed server IDs (never tokens/auth state) pass to the
  first teammate session at completion. Workspace creation happens at
  completion, not in the auth drawer.
- GitHub uses the reviewed `io.github.github/github-mcp-server` PAT recipe.
- **Slack is gateway messaging, not MCP.** Slack MCP is absent from Catalog (no
  DCR; needs an approved confidential app) — don't re-add it, offer generic
  registration, or use gateway tokens for MCP. Present one deselectable Slack
  gateway goal, never preselected; deselecting clears new-gateway intent.
  Existing enabled, permission-usable gateways are preferred without changing
  their branch-bound destination. Only an admin with a checked-empty inventory
  may request new-gateway help; that request is intent, not authority —
  completion and the teammate recheck, using one disabled draft and the secure
  gateway token widget before enabling. A gateway does not provide Slack
  history/tool access.

## Tools row visuals

- One full-width row per provider (`OnboardingToolRow`): monochrome `McpLogo`
  mark, semibold name, smaller description. Do not restore a two-column grid.
- Standard AntD Card/Flex/Typography with theme tokens (`fontSize`,
  `fontSizeSM`, `controlHeight`, `padding*`), not bespoke CSS or literal sizes.
- Inline SVG marks (no remote images/CSP failures); missing marks use the
  fixed-size neutral Agor fallback.
- Names/descriptions wrap, including long unbroken names. Action labels carry
  the full provider name and purpose. Read readiness from the caller-scoped
  Catalog hook; never infer authorization from selection.
- Auth requirement: outlined neutral `Tag` beside the title. Text actions use
  `fontSizeSM`, zero left padding, and at least `controlHeight` targets; wrapped
  targets stay separate so Retry remains clickable.
- Disclosure uses the parent-owned `CatalogDetailSection` AntD Collapse; Enter/
  Space toggle only its header and never intercept keys in consent or credential
  controls. Loading must not mount another portal, replay open motion, or move
  focus.
