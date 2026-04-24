# PR Review: fix(ui): fix onboarding wizard infinite spinner and repo matching bugs

**PR:** preset-io/agor#1062  
**Author:** aminghadersohi  
**Branch:** amin/fix-onboarding-wizard-bugs  
**Reviewed by:** Claude Code (review-agor-1062 session)

---

## What the PR Does

Fixes seven bugs in the onboarding wizard (`OnboardingWizard.tsx`) and related code:

1. **Infinite spinner on own-repo path** — `handleStartClone` called the clone API but never set `currentStep` to `'clone'`, so the auto-advance effect watching `repoById` never ran.
2. **Slug required error** — backend `cloneRepository` required a slug even though the UI marks it optional; now auto-derives from the URL.
3. **Silent failure in `handleCreateRepo`** — errors were caught but not rethrown, so the OnboardingWizard never saw the failure.
4. **Worktree name input fight** — the `useEffect` initializing the default worktree name included `worktreeName` in its dependency array, so clearing the field immediately re-set it.
5. **URL mismatch on clone detection** — the auto-advance effect compared `repo.remote_url` against the user's input verbatim; repos whose remote URL had `.git` stripped by the backend wouldn't match.
6. **`createdRepoId` not set on page resume** — if the wizard restarted mid-flow the repo ID wasn't always recovered before reaching the board/worktree steps.
7. **Steps indicator wrapping** — the 640px modal couldn't fit separate "Add Repo" + "Clone" labels; the clone step is now merged into the repo step in the indicator.

---

## Reviewer Comments

No reviewer comments were posted on this PR at the time of review. The analysis below reflects a self-review of the diff.

---

## Fix-by-Fix Analysis

### 1. `handleStartClone` — own-repo path never set `currentStep` to `'clone'`

**Change:** `OnboardingWizard.tsx` — after successfully calling `onCreateRepo` / `onCreateLocalRepo`, adds:

```typescript
if (path === 'own-repo') {
  setCurrentStep('clone');
}
```

**Assessment: Correct.** The auto-advance `useEffect` guards with `if (currentStep !== 'clone' || !loading) return;`. Without this transition the effect never fired and the spinner ran forever.

For local repos the code still transitions to `'clone'` with `loading=true`, then relies on the WebSocket `repoById` update to advance. No timeout is set for local repos (`if (repoMode !== 'local') { ... }`). This is acceptable — local registration is synchronous on the backend and the update arrives in milliseconds. A future improvement could add a short timeout as a safety net, but it's out of scope here.

---

### 2. Slug auto-derivation in `repos.ts`

**Change:** `apps/agor-daemon/src/services/repos.ts` — when `slug` is falsy, derive it from the URL:

```typescript
const urlPath = new URL(data.url).pathname;
slug = urlPath.replace(/^\//, '').replace(/\.git$/, '');
```

With a try-catch fallback for non-URL strings that takes the last two path segments.

**Assessment: Correct.** Handles the common case (`https://github.com/user/repo.git` → `user/repo`), the `.git`-stripped case, and non-URL strings gracefully. The idempotency guard (`findBySlug`) below this code also prevents duplicate entries if the user clicks twice.

---

### 3. Error rethrow in `handleCreateRepo` (App.tsx)

**Change:** `apps/agor-ui/src/App.tsx` — adds `throw error;` in the catch block and removes the premature success toast:

```typescript
} catch (error) {
  showError(`Failed to clone repository: ...`);
  throw error;  // was missing
}
```

**Assessment: Correct.** `handleStartClone` in the wizard catches this error and sets the error state. Without the rethrow, the wizard saw a resolved promise and kept `loading=true` indefinitely.

---

### 4. Worktree name init loop

**Change:** `OnboardingWizard.tsx` — replaces the loop-prone `useEffect` with a ref-gated one-time init:

```typescript
const worktreeNameInitRef = useRef(false);
useEffect(() => {
  if (path === 'own-repo' && !worktreeNameInitRef.current) {
    worktreeNameInitRef.current = true;
    setWorktreeName('my-worktree');
  }
}, [path]);
```

**Assessment: Correct.** Using a `ref` to gate one-time initialization is the standard React pattern. The old code's inclusion of `worktreeName` in the dependency array caused the effect to re-run after the user cleared the field, resetting it immediately.

---

### 5. URL normalization (`.git` stripping)

**Change:** `OnboardingWizard.tsx` — two places now normalize before comparison:

```typescript
const normalizeUrl = (url: string) => url.replace(/\.git$/, '').replace(/\/$/, '');
```

Applied in both the auto-advance effect and the safety-net effect.

**Assessment: Correct.** The backend strips `.git` from `remote_url` during slug derivation; without this the input URL `https://github.com/org/repo.git` would never match `https://github.com/org/repo`. Trailing-slash normalization is a bonus.

---

### 6. Safety net for `createdRepoId`

**Change:** New `useEffect` that fires when `currentStep` is `'board'` or `'worktree'` and `createdRepoId` is still null. Re-scans `repoById` by URL, slug, local path, or framework-repo heuristic.

**Assessment: Correct.** Handles the resume-from-refresh scenario without disrupting the happy path (the early-return on `createdRepoId` makes it a no-op once the ID is set).

---

### 7. Steps indicator — merge clone into repo step

**Change:** `OnboardingWizard.tsx` — steps are filtered before rendering:

```typescript
const displaySteps = allSteps.filter((s) => s !== 'welcome' && s !== 'clone');
```

When `currentStep === 'clone'`, the indicator highlights the mapped step (`'add-repo'` for own-repo path, or the first visible step for assistant path).

**Assessment: Correct.** Prevents label wrapping in the 640px modal without hiding the actual clone progress from the user (the spinner and elapsed timer still render inside the step content area).

---

## Additional Issues Spotted

None of significance. The code is clean, the React patterns used (ref gating, effect guards on `currentStep + loading`, normalized comparisons) are appropriate.

One minor observation: the `normalizeUrl` helper is defined inline in two separate `useEffect` closures rather than extracted to a module-level constant. This is harmless (the function is pure and cheap) but extracting it would remove duplication. Given the PR scope this is not worth blocking on.

---

## Verdict

All seven fixes are correct. No reviewer comments to address. No changes required.
