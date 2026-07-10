# Agor home page design proposal

## Summary recommendation

Make the home page a **boards portal first, personalized dashboard second, onboarding hub when empty**.

The board remains Agor's primary work surface, so home should not replace the canvas. It should answer three questions quickly:

1. Where should I go? → boards and active/recent branches.
2. What needs attention? → running/awaiting/recent sessions across all boards.
3. What is the team doing? → lightweight presence/activity and recent Knowledge.

Recommended default route: `/home` (and eventually `/` after login). Keep direct board URLs as the deep-linkable work surface.

## Grounding in current app patterns

Relevant existing patterns and files:

- **Boards/branches are primary work units**: `context/concepts/branches.md`, `apps/agor-ui/src/components/SessionCanvas/`, `apps/agor-ui/src/components/BranchCard/`.
- **Board switching and recents**: `AppHeader` uses `BoardSwitcher` and `useRecentBoards` with localStorage-backed recent boards.
- **All sessions pattern**: `BoardTeammatePanel` embeds `BoardSessionList`, which combines `SessionSearchToolbar`, `sortSessions`, `searchSessions`, branch/repo context, status badges, and empty/search states. This is the best starting point for a global sessions list.
- **Knowledge surface**: `KnowledgePage` already fetches `kb/namespaces`, `kb/documents`, and `kb/search`; recent docs can reuse document rows (`title`, `path`, `kind`, `updated_at`, `url`).
- **Activity/presence**: `GlobalPresenceFacepile` and `usePresence({ globalPresence: true })` provide active users and board IDs. `useEventStream` is a debug stream, not a polished activity feed, but its socket events show that the needed raw events already exist.
- **Empty states**: Ant Design `Empty.PRESENTED_IMAGE_SIMPLE` is used broadly; more useful empty states usually add one primary action, one secondary action, and short explanatory copy.

### Navbar board switcher on Home

Current pattern: `AppHeader` shows an in-navbar `BoardSwitcher` when a `currentBoardId` exists, plus up to three recent board icon pills from `useRecentBoards`.

Recommendation for Home/no-board state:

- Keep a board switcher in the navbar, left of global search. On Home/no-board state, render it as a neutral **Jump to board** control when there is no current board.
- Keep the three recent board icon pills next to it; they are fast shortcuts, not a replacement for the Home Boards section.
- Selecting a board from Home navigates to that board and restores the normal current-board navbar state.
- If there are no boards, hide/disable the switcher and show primary creation affordances in the page body.

This avoids making Home feel disconnected from the existing board navigation model while preserving Home as a no-board route.

## Goals

- Provide a low-friction starting point for both solo users and teams.
- Reduce dependence on remembering which board contains active work.
- Surface work that needs attention across boards without forcing users to enter each board.
- Preserve boards as the spatial home for actual work.
- Give new instances a clear path from zero data to first useful board/session.
- Reuse current UI vocabulary: Ant cards/lists, status badges, facepile, board emoji icons, session search/sort controls, branch/repo pills where practical.

## Non-goals

- Do not build a linear replacement for boards or a full global kanban.
- Do not create a noisy Slack-style firehose on day one.
- Do not make Knowledge dominate the page; it is supporting context unless the user intentionally enters Knowledge.
- Do not require new backend aggregation APIs for the first cut if existing hydrated App data is enough.
- Do not change branch/session ownership semantics or board-scoped permissions.

## Candidate sections and priority

### P0: Page header and quick actions

Purpose: orient the user and provide obvious starts.

Content:

- For V1 implementation, omit the agentic brief. If/when added later, collapse the page title and brief into one compact closable **Home** card.
- Future brief content should use rich links to boards, branches, teammates, sessions, artifacts, and comments, and answer: what happened in the past 48h and what needs attention now.
- Search entry point remains in the navbar via existing `GlobalSearch`.
- Primary creation action: reuse the board-style large circular **+** floating at top-right; no inline creation buttons needed in the Home card.
- Connection state and user menu can remain in the shared header.

Why P0: the home page should feel useful even when all lists are empty.

### P0: Boards portal with teammate context

Purpose: route users to the right canvas or the right long-lived agent.

Recommendation: keep the primary section named **Boards**. “Workspace” is not part of Agor’s information architecture. Teammates should appear as context inside board cards when they are primary/attached, with a small fallback for unassigned teammates if needed.

Card variants:

- **Board with primary teammate**: show board icon/name, teammate avatar/name, branch/session counts, active users, and latest prompt/activity.
- **Board without teammate**: show board stats and a soft “Assign teammate” affordance.
- **Teammate not attached to a board**: optionally show in a small “Unassigned teammates” row or secondary card group. Do not rename the section around these outliers.

Card data:

- board emoji + title in a single line, plus description. Avoid putting status badges in the title row; activity/status can appear in supporting metadata if needed.
- primary teammate id/name/emoji when present
- branch count
- active/running/awaiting session counts
- latest prompt summary/time for the board or teammate
- unread root comments count, if already available
- active users on that board from global presence
- `last_updated` or derived latest branch/session activity

Scope/framing:

- Default label should be **Boards**, not “Your boards”. Agor is multiplayer; over-personalizing the primary section hides team work.
- Default row set should be all boards the current user can access, with stronger ranking for active/recent/mine.
- Add quick filters/chips instead: **All**, **Mine**, **Active**, **Teammates**, **Recent**.
- “Mine” can mean boards created by me or boards with active/recent sessions created by me. If RBAC owners are enabled later, use ownership/membership instead of creator-only.
- Do not hard-limit the section to three boards. Three recent icons already exist in the navbar pattern; Home should be a broader board browser.

Layout recommendation:

- Show a horizontally scrollable row of board cards on desktop, with 4-6 cards visible depending on width.
- Include a “View all boards” affordance or expand control for instances with many boards.
- Consider pinned boards later, but v1 can sort by activity/recency.

Recommended ordering:

1. boards with active/running/awaiting sessions
2. recent boards from `useRecentBoards`
3. boards with recently prompted primary teammates
4. boards with recent branch/session/comment activity
5. alphabetical fallback

Board activity:

- There is not currently a dedicated board-activity entity. For v1, derive activity from related entities: latest branch creation/update, latest session `last_updated`, latest unresolved root comment, and primary teammate prompt metadata if added.
- Longer term, `activity/summary` can return a board-scoped `last_activity_at`, `last_activity_kind`, and short display label.

Interaction:

- Click board card → navigate to board.
- Click teammate chip/avatar → open teammate branch/session affordance or teammate panel.
- Small affordances: comments badge, active user facepile, “New branch here”, “Prompt teammate” when a primary teammate exists.
- Card menu later: rename/archive/settings/assign teammate.

Alternative considered: separate **Boards** and **Teammates** sections. This is cleaner conceptually but wastes space for the common one-to-one case. Keep teammates attached to board cards unless unassigned teammates become common enough to deserve a small secondary section.

### P0: Your sessions

Purpose: personal continuation list: “what was I prompting, and what needs my input?”

Recommendation: rename the section from **Needs attention** to **Your sessions**. “Needs attention” is a useful filter, not the whole section. Users also need to resume sessions that are simply recent.

Default sort/filter:

- Default row set: sessions created by the current user or last prompted by the current user, sorted by `last_prompted_at` / `last_updated` descending.
- Promote attention states to the top within the same list: `ready_for_prompt`, `awaiting_permission`, `awaiting_input`, recent failures.
- Secondary tabs/chips: **Recent**, **Needs input**, **Running**, **Failed**, **All team**.

Content:

- Include branch name, board, repo, agent icon, title, status, creator, last prompt time.
- Reuse `SessionSearchToolbar` and session search utilities, but add a global-current-user filter before sorting.

Layout/interaction:

- Render as an in-page SPA section, not a drawer/modal. Home should remain a full SPA page where lists scroll independently inside the page.
- Show roughly 8-12 rows before internal scrolling; this is a continuation surface, not a tiny summary.
- Click row → navigate to session deep link.
- “All team” expands from personal continuation to a global session browser/filter on the same page.

### P1: Recent work

Purpose: a broader cross-board history after the urgent set.

Content:

- Recent sessions, recent branches, and maybe recent artifacts as a compact mixed list.
- Prefer sessions initially because the app already has `sessionById` and branch/repo maps.

Interaction:

- Rows deep-link to session/branch/board.
- “View all sessions” opens a global sessions drawer/page.

### P1: Team activity

Purpose: social awareness without creating a firehose.

Recommendation: make this a **curated activity feed**, not raw session CRUD. Session-level events can become noisy quickly. Track events that indicate board shape, ownership, or explicit human intent.

Event taxonomy for v1:

- `branch.created`: “Anna created branch Checkout refactor” — high signal because branches are the anchor unit.
- `teammate.created`: “Max created Marketing Bot” — high signal and rare.
- `teammate.assigned_to_board`: “Marketing Bot was assigned to Launch board” — important board/teammate setup event.
- `teammate.prompted`: “Anna prompted Marketing Bot” — distinct from generic session prompts because it communicates human intent toward a durable teammate. Store `last_prompted_by`, `last_prompted_at`, and optionally a short prompt title/summary on the teammate/branch summary.
- `artifact.published`: “Jordan published Signup flow mock” — useful when artifacts become shareable review objects.
- `comment.mentioned_user`: “Sam mentioned you on Review Queue” — only prominent for the mentioned user.

Events to avoid or aggregate initially:

- Raw `session.created`, `session.patched`, `message.created`: too noisy.
- Session completion: only surface if failed, awaiting permission, or attached to an teammate/branch the current user follows.
- Branch/session updates from agents: aggregate as “3 sessions ran on Review Queue” rather than stacking each patch.

Stacking/grouping rules:

- Group repeated events by actor + target + time window, e.g. “Anna prompted Marketing Bot 3 times”.
- Collapse background agent chatter under the branch/teammate card, not the main activity feed.
- Prioritize events involving the current user, then active boards/teammates, then global recent events.
- Keep only 5-8 visible rows on Home with a “View activity” link.
- Make actor and target text clickable: user links open profile/user context; branch/teammate/artifact/comment links deep-link to the relevant Agor object.

Implementation note: start with presence-only plus latest teammate prompt metadata if available. Add persisted activity later. The polished feed likely needs a unioned/derived query across CRUD sources.

### P1: Recent Knowledge

Purpose: make durable context discoverable.

Content:

- recently updated readable Knowledge docs: title, namespace/path, kind, updater, relative time
- optional search field linking to Knowledge search

Interaction:

- Click doc → `/kb/:namespace/:path`.
- Empty state → “Create Knowledge page” and “Open Knowledge”.

### P2: Teammate / schedule digest

Purpose: expose long-lived automation.

Content:

- primary teammates per board
- scheduled branches with next/last run
- stale/failed scheduled runs

Why P2: useful, but less universal than boards and sessions.

## Recommended information architecture

### Established team layout

### Theme

Use Agor's default Ant Design theme rather than a bespoke visual language. The default theme is defined in `apps/agor-ui/src/contexts/ThemeContext.tsx` as an AntD `ThemeConfig` with Agor teal (`colorPrimary: #2e9a92`), standard AntD status colors, `borderRadius: 8`, and the active light/dark algorithm.

Implementation guidance:

- Build the real Home page with AntD components and `theme.useToken()`.
- Avoid hard-coded custom blues/gradients in the product UI.
- Use `token.colorBgContainer`, `token.colorBgElevated`, `token.colorBorderSecondary`, `token.colorText`, `token.colorTextSecondary`, and `token.colorPrimary`.
- The mock approximates the default dark tokens only because it is static HTML/CSS.

### SPA page width

Because Home is a SPA page, it should use the full available viewport width rather than behave like a centered document page. The page is an app surface with multiple independent information regions.

Recommendation:

- Use full-width, full-height layout below the global navbar (`height: calc(100vh - header)`) so Home behaves like an app surface, not a document.
- Keep generous page padding so the full-width SPA can breathe; mocks are testing a larger desktop gutter, but do not cap the whole page at a narrow content width.
- Use a fixed-ish right rail on desktop and let the main column absorb width. The right rail should consume the available vertical height.
- On wide screens, the right rail should start at the top of the page alongside the hero/brief rather than below them. The hero belongs to the main column, not as a full-width band.
- On very wide screens, add more visible board cards rather than leaving large margins.
- Individual text elements should still have readable max widths; the full-width behavior applies to the dashboard grid, not every paragraph.

Desktop, 12-column feel:

1. **Main left column**
   - Compact closable Home brief at the top.
   - Floating create button top-right.
2. **Main left column continued**
   - Boards grid with primary teammate context.
   - Your sessions continuation list.
3. **Right rail (top-aligned)**
   - Team activity / presence.
   - Recent Knowledge.
   - Optional “Recently visited” shortcuts.

Responsive:

- Under tablet width: stack sections in the same priority order and relax fixed-height/internal-scroll behavior.
- On desktop, avoid page-level vertical overflow: the left column should be a full-height flex column, with **Your sessions** taking remaining height and scrolling internally.
- Keep “Your sessions” above “Recent Knowledge” on small screens; let the session list scroll within the page after about 8-12 rows.

### New instance / empty board layout

Use the same route but swap from dashboard to onboarding state when there are no boards and no repos/branches.

Recommended empty state:

1. Hero: “Home” plus the canonical tagline nearby if marketing context is needed.
2. Three setup cards:
   - **Add a repo** → Settings/repos or create dialog.
   - **Create your first board** → board create flow.
   - **Start a branch/session** → create branch once a repo exists.
3. Small “Try with sample board” option if sample data exists or can be added later.
4. Knowledge empty card: “Capture decisions, prompts, and team context.”

Intermediate empty states:

- **Boards exist, no branches**: emphasize “Create branch on a board”, not repo setup.
- **Branches exist, no sessions**: show boards and branch cards, prompt “Start first session”.
- **Solo instance**: hide “what others are doing” language; show “Your active work”.
- **Disconnected**: show cached/local lists as read-only and disable mutation actions, matching current header behavior.

## Explanation layer

Add a subtle info trigger to each major Home section. This is useful because the page blends entities (boards, teammates, sessions, Knowledge, activity) and users will reasonably ask why a row appears.

Recommended pattern:

- Use a small `InfoCircleOutlined` button beside each section title.
- On hover/focus, show a Popover with:
  - what belongs in the section
  - where the data comes from
  - how rows are sorted/grouped
  - what the empty state does
- Keep this explanatory copy product-facing but precise enough for admins/operators.

Initial popover content:

- **Boards**: boards with their primary teammate context when present. Data from `boardById`, `branchById`, `sessionsByBranch`, primary teammate config, comments, and presence. Empty state prompts repo/board/branch setup.
- **Your sessions**: sessions created or last prompted by the current user, sorted by last prompt/update, with attention states promoted. Empty state prompts starting a session from a board.
- **Team activity**: curated events, not raw session CRUD. Data eventually comes from an `activity/summary` union over branch creation, teammate creation/assignment/prompting, artifact publishing, and mentions. Empty state can show active presence or hide.
- **Recent Knowledge**: readable Knowledge documents sorted by `updated_at`, from `kb/documents`. Empty state opens Knowledge/create doc.
- **Home brief**: optional future agent-generated summary from the same home/activity summary data. It should be a compact, closable rich-content card focused on the last 48h and attention items.

The mock includes hoverable `i` triggers to demonstrate this layer.

## Data dependencies and APIs needed

### Can ship from existing hydrated app data

The current Workspace `App` already receives enough data for a first home surface:

- `boardById`: board cards, names, icons, descriptions, archived flag.
- `branchById`: board membership and branch counts.
- `sessionById` / `sessionsByBranch`: global active/recent sessions, status, creator, timestamps, title.
- `repoById`: branch repo context.
- `commentById`: unread/open board comment counts if desired.
- `userById`: creators, facepile labels.
- `artifactById`: optional recent artifacts later.
- `mcpServerById`: not needed for v1 home.

Derived selectors needed in UI:

- `getBoardCards(boardById, branchById, sessionsByBranch, userById)`
- `getBoardStats(board, branchById, sessionsByBranch, comments)`
- `getBoardActivity(board, branches, sessions, comments, teammatePromptMetadata)`
- `getTeammateBoardStats(teammateBranch, board, sessions)`
- `getGlobalSessionRows(sessionById, branchById, boardById, repoById)`
- `getYourSessions(rows, currentUserId)`
- `getNeedsAttentionSessions(rows)`
- `getRecentBoardsPlusActivity(recentBoards, boardStats)`

### Existing services for incremental fetches

- Boards: `boards.find`, `boards.get`, plus board object data already in workspace hydration.
- Sessions: current session data is already live; a backend `sessions.find` query can support a lighter `/home` surface later.
- Knowledge: `kb/documents.find({ query: { archived: false, $limit, $sort: { updated_at: -1 } } })` if sorting/pagination are supported consistently; otherwise fetch readable docs and sort client-side for v1.
- Presence: `usePresence({ globalPresence: true })` for active users and board IDs.

### Likely new APIs for polished later phases

- `home/summary`: server-side aggregate for boards, counts, attention sessions, recent docs, and recent artifacts. Useful if `/home` should be a lightweight surface that does **not** start the full Workspace runtime.
- `activity.find`: persisted, permission-aware activity events with filters (`board_id`, `teammate_branch_id`, `user_id`, `event_type`, time range). Avoid relying on debug `useEventStream` for product UI.
- `activity/summary` or `home/activity`: unioned query over branch creation, teammate creation/assignment, teammate prompts, artifact publishes, and comment mentions, with server-side grouping/de-duping.
- `sessions.find` query improvements if needed: status arrays, `ready_for_prompt`, `created_by`, branch/board joins, sort by activity.
- `kb/documents` recent query contract: explicit `$sort`, `$limit`, and optional namespace slug in response/deep link.

## Phased implementation plan

### Phase 0: Design artifact and route decision

- Align on whether home starts Workspace runtime or gets a lightweight surface.
- Decide if `/` redirects to `/home`, last board, or onboarding based on data.
- Decide section names and empty-state copy.

### Phase 1: Client-only home inside Workspace runtime

Fastest, lowest API risk.

- Add `/home` as a Workspace route/surface that uses existing hydrated maps.
- Reuse `AppHeader`, `GlobalSearch`, `BoardSwitcher` patterns.
- Build `HomePage` components:
  - `BoardHomeCard` (board + primary teammate summary)
  - `YourSessionsList`
  - `HomeEmptyState`
  - `RecentKnowledgeCard` with simple client fetch
  - `PresenceActivityCard`
- Add navigation affordance from logo or header.
- Keep mutation actions wired to existing create dialogs.

Tradeoff: loads full app data even for home. Acceptable for a first product iteration because the current app already does this for boards.

### Phase 2: Product polish and state memory

- Add user-level home preferences: pinned boards, collapsed sections, default session filter.
- Add richer board metrics and better “mine/team” filters.
- Improve mobile stacking and keyboard navigation.
- Add snapshots/tests for empty states and selectors.

### Phase 3: Lightweight home surface and activity API

- Add a server aggregate (`home/summary`) so `/home` can load without SessionCanvas.
- Add persisted activity feed with permission-aware event filtering.
- Let `/` choose intelligently:
  - no boards/repos → onboarding home
  - has attention items → home
  - explicit last board preference → board

## Implementation handoff notes

### Decisions from design review

- Home route should be `/`; logo should navigate to Home.
- The large circular `+` should reuse the existing create flow, with **Teammate** as the default tab/action from Home.
- Board picker label should be **Home** (not Dashboard) and should include an emoji so it matches board rows. Home is pinned at the top of the picker and remains visible while scrolling a long board list. Home should not appear in the three recent-board icon shortcuts.
- V1 should prefer shared/local app state for boards, sessions, branches, comments, users, and presence so Home updates in real time “for free”. Knowledge may need a direct service fetch.
- Team activity should have a real union/summary data source when local state is insufficient, but avoid raw noisy session CRUD.
- Recent Knowledge should use existing KB APIs if they can return recently modified/created readable documents while respecting Knowledge RBAC.
- Your sessions should reuse the Board left-panel All Sessions visual/pattern, but be cross-board instead of board-filtered. Include a board pill when no board filter is passed.

V1 scope for an implementation subsession:

- Build a real Home SPA page using AntD and existing Agor components/patterns.
- Keep the agentic brief out of V1. The brief remains an interesting future feature, but should not block the page.
- Use clear section/widget components that can be reused later, potentially as board widgets:
  - `HomePage`
  - `HomeBoardsSection` / `BoardHomeCard`
  - `HomeSessionsSection` / `HomeSessionRow`
  - `HomeActivitySection` / `ActivityFeedItem`
  - `HomeKnowledgeSection` / `KnowledgeDocRow`
  - `HomeSectionHeader` with optional info popover
- Use Agor's default AntD theme via `theme.useToken()`; avoid bespoke mock CSS.
- Reuse existing search/sort/session utilities where practical.
- Keep Home full-width/full-height as a SPA page with internal scrolling in large sections.
- Retrofit the navbar board picker so Home appears at the top and remains available while scrolling long board lists.
- Unwire current startup behavior that redirects automatically to the last active board; Home should be a valid no-board route.
- Keep the large circular top-right create button pattern.

Suggested implementation order:

1. Route/nav shell: add Home route and no-board Home state; stop auto-redirect to last board.
2. Board picker: include Home at top; support current route with no board selected.
3. Home layout scaffold: full-height SPA grid using AntD tokens.
4. Boards section from existing `boardById`, `branchById`, `sessionsByBranch`, comments/presence where available.
5. Your sessions section from existing session maps and `sessionSearch` helpers.
6. Right rail: start with derived/presentational Team activity and Recent Knowledge; keep future activity API as TODO.
7. Empty states and tests for no boards, no sessions, disconnected, and many boards/sessions.

## Open product questions

1. Should the Agor logo navigate to Home, current board, or last visited board?
2. Is Home the default after login, or should returning users land on their last board?
3. Should boards/teammates be manually pinnable/favoritable, or is recency/activity enough?
4. How much social activity is desirable before it feels noisy?
5. Should Knowledge be presented as “recent documents” or as “team memory” with recommended docs?
6. What is the first-run flow when there are no repos: create local repo, register existing repo, or show docs?
7. Should admins see instance health/setup warnings on Home while members do not?
8. Do we want global “All sessions” as a standalone page/drawer, or only as a home section?
9. What is the exact source of truth for `last_prompted_by` / `last_prompted_at` on teammate branches?
10. Should teammate prompt activity include prompt text, prompt title only, or no prompt content for privacy/noise control?

## Lightweight mock

A static mock lives at:

- `context/explorations/agor-home-page-mock/index.html`
- `context/explorations/agor-home-page-mock/index.js` (Sandpack artifact entry)
- `context/explorations/agor-home-page-mock/styles.css`

Open it directly in a browser, or publish it as an Agor artifact from the folder.
