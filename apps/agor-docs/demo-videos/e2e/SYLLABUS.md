# The Agor syllabus

A soup-to-nuts course in real Agor, taught by the E2E suite itself. Every
lesson in `tests/flow/` drives the REAL daemon + UI — no fixtures, no staged
components — starting from a completely empty workspace and onboarding it
one step at a time. Each lesson:

- **is a regression test** — it runs against real services and asserts real
  outcomes (a worktree materialized, a credential probe passed, a model
  reply streamed);
- **records a training-ready video snippet** — paced for a human viewer
  (eased cursor glides, spotlight dwells on options worth knowing, holds on
  payoffs), signed in from the first frame, 1080p by default;
- **leaves the state the next lesson starts from** — the suite is one
  continuous story, so lessons must run in order (`workers: 1`, no retries).

## Running it

```bash
npm run test:replay   # the whole flow, no network, no model cost —
                      # agent turns replay from the committed cassette
npm run test:live     # re-records the cassette: real (metered) model calls
npm test              # UI/DB lessons only; agent lessons skip
```

- `AGOR_E2E_VIDEO=4k` — record 3840x2160 (true 2x raster; ~4x the size).
- `AGOR_E2E_KEEP_SCRATCH=1` — skip the from-zero reset to iterate on one
  later lesson against existing state:
  `AGOR_E2E_KEEP_SCRATCH=1 AGOR_E2E_AGENT_MODE=replay npx playwright test tests/flow/03-*.spec.ts`

Videos land in `test-results/<lesson>/video.webm` (cleared each run — copy
out keepers).

## The lessons

| #   | Lesson                  | What it teaches                                                                     | Ends with                                                                         |
| --- | ----------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 00  | First run               | The onboarding wizard: goal cards, skippable steps                                  | The wizard-made board, open on an empty canvas                                    |
| 01  | Connect your repository | The Create dialog's Repository tab; clone-from-URL vs register-local                | donut-shop registered ("Local repository added successfully!")                    |
| 02  | Connect your AI         | The Connect AI flow in Settings; credentials verified by a real probe               | Both amber credential banners genuinely gone                                      |
| 03  | Your first branch       | Branch options: source branch, worktree vs clone, issue/PR links                    | A real worktree branch card on the canvas, error-free                             |
| 04  | Your first session      | The coding-agent picker; prompting; following up — sessions are conversations       | Two real Claude turns: an architecture tour, then a concrete improvement proposal |
| 05  | Organize your board     | Zones as workflow lanes; inline rename; the zone trigger config; dragging a card in | "In Progress" / "Review" zones with the branch card filed                         |

Planned next (roughly in order): primary teammate for the board, MCP tools
(donut-shop's MotherDuck database is the natural first server; an
Agor-to-Agor MCP against a live instance is a candidate later), opening a
PR from a branch, PR review flows, and multi-account multiplayer captured
with two browser contexts. A true second-provider lesson (Codex alongside
Claude) is live-only for now: the Codex CLI ignores OPENAI_BASE_URL
(verified empirically — a stub upstream got zero hits), so its traffic
can't be cassette-recorded without deeper provider-config plumbing.

## How the from-zero environment works (support/harness.ts)

- Scratch SQLite DB + git data home in `.e2e-runtime/` (wiped every run),
  dedicated ports — never touches `~/.agor`.
- The daemon's own first-run bootstrap creates the development admin
  (`admin@agor.live` / `admin`, three explicit env gates, dev-only).
- Login happens over REST in global-setup and is minted into a Playwright
  storageState — recordings never show the login form.
- Demo repos are mirrored once into `.e2e-cache/` (the only network fetch
  ever) and fresh working clones are cut per run: `preset-io/donut-shop`
  (the project the syllabus onboards — issues, PR history, a site, a
  MotherDuck backend) and `preset-io/agor-teammate` (pre-registered via
  `POST /repos/local` so the onboarding wizard's auto-clone never fires
  mid-recording).
- Agent traffic goes through the record/replay cassette proxy
  (support/cassette-proxy.ts) via the credential's base-URL override —
  see support/agent-settings.ts for why the API-key sign-in method is the
  sanctioned way to carry one.

## Conventions for new lessons

- Number the file (`NN-name.spec.ts`); order is execution order.
- Use `support/pacing.ts` verbs (`glideAndClick`, `spotlight`, `typeInto`,
  `beat`, `settle`) — never raw `click()`/`type()` — so the video reads as
  a person demoing, not a test racing.
- Open with `openLesson(page, path)`; re-`reassertCursor` after in-app
  navigations that re-render the shell.
- Assert the lesson's real outcome, and never on text the lesson itself
  typed (the prompt echoes into the transcript — a reply must be proven by
  words only the model could have produced).
- Gate model-touching lessons on `resolveAgentMode()`.
