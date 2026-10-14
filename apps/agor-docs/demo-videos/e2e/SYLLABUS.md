<!-- GENERATED from support/syllabus.ts — edit there, then `npm run syllabus:md`. -->

# The Agor syllabus

A soup-to-nuts course in real Agor, taught by the E2E suite itself. Every
lesson in `tests/flow/` drives the REAL daemon + UI — no fixtures, no staged
components — starting from a completely empty workspace and onboarding it
one step at a time. Each lesson:

- **is a regression test** — it runs against real services and asserts real outcomes;
- **records a training-ready video snippet** — paced for a human viewer, signed in from the first frame, 1080p by default (`AGOR_E2E_VIDEO=4k` for true 4K);
- **leaves the state the next lesson starts from** — one continuous story, so lessons run in order (`workers: 1`, no retries).

## Running it

```bash
npm run test:replay   # the whole flow, no network, no model cost
npm run test:live     # re-records the cassette: real (metered) model calls
npm test              # UI/DB lessons only; agent lessons skip
npm run reel          # stitch the lesson videos into one reel (titles + crossfades)
npm run syllabus:md   # regenerate this file from support/syllabus.ts
```

`AGOR_E2E_KEEP_SCRATCH=1` skips the from-zero reset to iterate on one later
lesson against existing state. Videos land in `test-results/<lesson>/video.webm`
(cleared each run — `npm run reel` snapshots them).

## Lessons

### 00 · First run

_A brand-new workspace, and the wizard that greets it_

1. Open a signed-in, completely empty Agor — the onboarding wizard greets its first user
1. Tour the goal cards (personal teammate, ship without busywork, build me an app…)
1. Pick "Dig into anything" and continue
1. Skip the optional steps — every one of them gets its own lesson later
1. "You're ready to build." — open the board the wizard created

**Ends with:** An empty board canvas ("Admin's board"), ready for real work

### 01 · Connect your repository

_Point Agor at the code — clone a URL or register a local checkout_

1. From Home, open the board; the + button opens "Create New..."
1. The Repository tab: clone from a GitHub URL, or register a clone you already have
1. Choose "Local (existing)" and enter the donut-shop checkout path
1. Add Repository — the daemon inspects the clone and registers it

**Ends with:** preset-io/donut-shop registered ("Local repository added successfully!")

### 02 · Your first branch

_An isolated worktree with a card on the board_

1. Create New... → Branch: pick the donut-shop repo
1. Worth knowing before naming it: source branch, worktree vs clone storage, issue/PR links
1. Name it glaze-menu-refresh and create
1. The card lands on the canvas and the worktree materializes — error-free

**Ends with:** A ready branch card offering "New Session"

### 03 · Connect your AI

_One credential, verified for real — the amber banner tells the truth_ · _agent lesson_

1. The "No AI connected" banner has been honest since first run — follow its Connect AI button
1. Settings → Claude Code: paste a credential and a base URL
1. The daemon probes the provider with the saved credential
1. Both amber banners clear — sessions can actually run now

**Ends with:** A verified Claude Code credential; no credential warnings anywhere

### 04 · Your first session

_A real agent conversation that reads the repo to answer_ · _agent lesson_

1. Start a session from the branch card — the panel opens with the coding-agent picker
1. Agor speaks Claude Code, Codex, Gemini, OpenCode and more; pick Claude Code
1. Ask for a tour of the repo — the agent reads the code before answering
1. Follow up: "what would you improve first?" — it digs back in and proposes a concrete fix

**Ends with:** A two-turn transcript ending in "Want me to go ahead and make that change?"

### 05 · Organize your board

_Zones turn a canvas into a workflow_

1. Draw two zones with the zone tool; rename them inline: "In Progress", "Review"
1. Peek at zone configuration — a trigger template can fire a prompt when a branch lands
1. Drag the branch card into "In Progress"

**Ends with:** A board with workflow lanes and the branch filed where it belongs

### 06 · Capture knowledge

_A shared, versioned markdown space agents can read too_

1. Open Knowledge from the header; New Page drops straight into the split editor
1. Write real markdown — the live preview keeps pace, the first heading becomes the title
1. Save: "Donut Shop Field Notes" joins the knowledge base

**Ends with:** A saved knowledge page, @-mentionable from any session prompt

### 07 · Parallel worktrees

_Two agents, one repo, zero collisions_ · _agent lesson_

1. A second branch off the same repo — quick this time
1. Its own session plans a "🍩 Daily Special" banner in its own worktree
1. End wide: two branch cards, two conversations, one repo — nothing steps on anything

**Ends with:** Two live branch cards on the board

### 08 · Make the change

_From proposal to diff — pick up where lesson 04 left off_ · _agent lesson_

1. Reopen lesson 04's conversation from the branch card — sessions are durable
1. The agent proposed a concrete fix and asked to implement it — say yes
1. Watch it edit for real; review the inline diff blocks in the transcript
1. The branch card now carries real, uncommitted work

**Ends with:** A reviewed diff on glaze-menu-refresh

### 09 · A teammate for the board

_A long-lived agent with identity, memory, and goals_ · _agent lesson_

1. Create "Sprinkles" via Create New… → Teammate (framework repo pre-registered)
1. Its first session starts bootstrapping the teammate for real — identity, memory, goals
1. Teammates preside over their own board — end there, Sprinkles at the helm
1. The bootstrap keeps working in the background while you move on

**Ends with:** Sprinkles presiding over Sprinkles's Board from the left panel

### 12 · Multiplayer

_Two people, live cursors, one board_

1. Create a second user (Ada) via Settings → Admin → Users — there is no email invite flow
1. Ada joins the same board in her own browser; her live cursor + name chip appear
1. Ada drags a branch card — it moves on the admin's screen in real time

**Ends with:** A visibly multiplayer board

## Planned

### 10 · Give your agent tools

_MCP: ask questions of the live MotherDuck database_ · _agent lesson_

1. Configure the MotherDuck MCP server (donut-shop's own database)
1. Attach it to a session; ask a data question ("top toppings this month?")
1. The agent answers from the real database, not the code

**Ends with:** A session with working MCP tools

> MOTHERDUCK_TOKEN is in .e2e-secrets (verified against the DonutShop DB). An Agor-to-Agor MCP against a live Preset instance is a later variant.

### 11 · Open a pull request

_Ship the branch: commit, push, PR — from the card_ · _agent lesson_

1. Commit the lesson-08 diff and push the branch
1. Open a PR and link it on the branch card
1. The card now wears its PR pill

**Ends with:** A real PR linked from the board

> Needs GitHub write access to donut-shop (or a fork strategy) — decide before building.

### 13 · A second provider

_Codex working alongside Claude_ · _agent lesson_

1. Connect Codex credentials; start a Codex session next to the Claude ones
1. Same board, different runtimes

**Ends with:** Mixed-provider sessions on one board

> LIVE-ONLY for now: the Codex CLI ignores OPENAI_BASE_URL (verified — a stub upstream got zero hits), so its traffic cannot be cassette-recorded without deeper provider-config plumbing.

## How the from-zero environment works (support/harness.ts)

- Scratch SQLite DB + git data home in `.e2e-runtime/` (wiped every run), dedicated ports — never touches `~/.agor`.
- The daemon’s own first-run bootstrap creates the development admin (`admin@agor.live` / `admin`, three explicit env gates, dev-only).
- Login happens over REST in global-setup and is minted into a Playwright storageState — recordings never show the login form.
- Demo repos are mirrored once into `.e2e-cache/` (the only network fetch ever) and fresh working clones are cut per run: `preset-io/donut-shop` (the project the syllabus onboards) and `preset-io/agor-teammate` (pre-registered via `POST /repos/local` so the onboarding wizard’s auto-clone never fires mid-recording).
- Agent traffic goes through the record/replay cassette proxy (support/cassette-proxy.ts) via the credential’s base-URL override — see support/agent-settings.ts for why the API-key sign-in method is the sanctioned way to carry one.

## Conventions for new lessons

- Add the lesson to `support/syllabus.ts` FIRST (status `planned`, with its beat sheet), then implement `tests/flow/NN-id.spec.ts` to match; flip to `done` when it records.
- Use `support/pacing.ts` verbs (`glideAndClick`, `spotlight`, `typeInto`, `beat`, `settle`) — never raw `click()`/`type()` — so the video reads as a person demoing, not a test racing.
- Open with `openLesson(page, path)`; re-`reassertCursor` after in-app navigations that re-render the shell.
- Assert the lesson’s real outcome, and never on text the lesson itself typed (a model reply must be proven by words only the model could have produced).
- Gate model-touching lessons on `resolveAgentMode()`.
