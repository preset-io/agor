# Onboarding Design

House rules for the first-run wizard
([`OnboardingWizard.tsx`](../../apps/agor-ui/src/components/OnboardingWizard/OnboardingWizard.tsx)).
Read this before changing that surface.

## Flow: no goal step

**Teammate → AI → Tools → You're ready.** Decision by Max, Seb and Kasia (2026-10-09): Agor can't
guess which tools a user has, so onboarding does not filter by goal or role and does not
front-load connections. Get people to their teammate fast, leave them seeing how much Agor connects
to, and let real connecting happen later with the teammate's help. Don't reintroduce goal, role or
persona questions, or goal-driven recommendations.

Legacy `preferences.onboarding.goals` and `persona` stay untouched: no migration, never read.

## Teammate step

- Welcome first: "Hi {first name}, meet your teammate" plus one line on what a teammate is. The
  title and that line collapse together when the cards scroll; the name field stays pinned.
- Name and emoji come first among the controls.
- "Pick a starting point": one even grid of template cards (3 columns, 2 at ≤480px), each antd icon
  (the template's `icon`) + title + one description line (two-line clamp, full text in a tooltip). No hero card, no category
  chips. **Personal assistant** is tagged Recommended and preselected; clearing a pick falls back
  to it. "Start from scratch" (the blank starter) is last. Use the shared `TeammateGallery`
  `compact` variant; Settings uses the same template list in its full gallery.
- Template data lives in `teammateTemplates.ts`. Prefer **prompt-only** templates (no
  `sourceBranch`, so the framework default branch like the blank starter, plus a `remit` line in
  the first-session prompt) over new branches in `preset-io/agor-teammate`.

## Tools step: Catalog wall

- A browsable wall of the whole visible MCP Catalog, not a recommendation list. One non-wrapping
  toolbar: search + category select. Filtering reuses `useCatalogSearch` (core `filterCatalog`).
- **Order follows the picked template; never filter.** A template may name `preferredTools`
  (Catalog entry names) and rank `preferredToolCategories`; `sortToolsForTemplate` lists those
  first and keeps the curated order for the rest. Only the unfiltered view is reordered; search
  and the category filter use the Catalog's order. Every tool stays visible and nothing is
  preselected. No template or "Start from scratch" keeps
  the curated order. Names must exist in the Catalog (a unit test checks).
- **No selection, nothing stored.** Only connections confirmed in the Catalog drawer pass, as
  server IDs, to the first teammate session at completion. Back and Skip never delete connections.
- The grid replaces the old one-row-per-provider layout: 3 columns, 2 at ≤480px. A tile is a
  button with the Catalog's own logo (`CatalogEntryAvatar` + `icon_url`, letter fallback), the
  Catalog display title, and the category label as one secondary line; the description lives in a
  Tooltip on hover and focus. "Connected" comes from caller-scoped readiness
  (`useCatalogReadiness`), never inferred.
- Logo hosts must stay in the daemon's default CSP `img-src` (`MCP_CATALOG_CSP_IMG_SRCS`);
  a blocked image falls back to the letter.
- AntD components and theme tokens only; sentence case.

## You're ready step

- Nothing is created until the primary click, so the copy says "almost ready" and names what comes
  next. While completion runs, the headline says "Setting up…" and a tips card (antd `Carousel`,
  `OnboardingSetupTips`) shows one capability at a time: every tip must be a feature that exists
  today. Auto-rotation pauses on hover/focus and is off under reduced motion; tips are not in a
  live region and hide on error. Slow and error states are unchanged.

## In-context Catalog

- A tile opens the existing `CatalogTab` / `CatalogDetailDrawer` through the shared `CatalogDrawer`
  seam with an explicit `context.mode: 'onboarding'`: no pathname detection, spacing overrides,
  second auth API or state machine, or completing onboarding just to open a drawer. Onboarding
  renders only the drawers.
- Catalog owns consent, readiness, policy, secure token input, the OAuth popup, and durable
  attempt + caller-scoped credential confirmation. Installation is not proof of OAuth success.
- Browsing creates nothing; Connect is install-only (no board, branch or session). No tryouts,
  session actions or starter prompts in onboarding; ready connections offer **Return to
  onboarding**.
- Cancellation erases private input; owner/generation replacement fences stale continuations.
  Tokens and auth state never leave the drawer. Workspace creation happens at completion.
- GitHub uses the reviewed `io.github.github/github-mcp-server` PAT recipe.
- **Slack is gateway messaging, not MCP.** Slack MCP is absent from Catalog (no DCR; needs an
  approved confidential app): don't re-add it, offer generic registration, or use gateway tokens
  for MCP. Onboarding no longer offers Slack gateway setup; the teammate helps later, using one
  disabled draft and the secure gateway token widget.

## Copy

The product noun is **teammate**. Plain, second person, sentence case, no em dashes in UI copy.
The voice source is the KB doc `marketing/messaging-and-positioning.md`.
