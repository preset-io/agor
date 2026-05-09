# Toast / Message Pattern

**One canonical hook. No exceptions.**

```tsx
import { useThemedMessage } from '@/utils/message';

const { showSuccess, showError, showWarning, showInfo, showLoading } = useThemedMessage();

showSuccess('Session archived');
showError('Failed to archive session');
```

Source: [`apps/agor-ui/src/utils/message.tsx`](../../apps/agor-ui/src/utils/message.tsx).

---

## What's wrong with `message.success(...)` from `'antd'`?

It's the **static** message API. It mounts outside the React tree, so it does **not** read `ConfigProvider` — your toast renders with the default light-mode palette even when the app is in dark mode. Same goes for `App.useApp().message` if used directly: it's themed but bypasses the wrapper, missing the standardized durations and the copy-to-clipboard affordance.

**Always use `useThemedMessage()`.**

---

## What the wrapper gives you for free

- **Theme integration.** Themed via `App.useApp()` under the hood.
- **Copy-to-clipboard on every toast.** A subtle copy icon appears at the right of the message. Clicking it copies the rendered text — handy for IDs, error traces, and anything else worth pasting into a bug report. No need to reach for a separate `<CopyButton>` inside the toast.
- **Standardized durations.** Success/info: 3s. Warning: 4s. Error: 6s (longer so users can read and copy). Override per-call with `{ duration }` if you have a reason.
- **Keyed loading→success/error.** Pass `{ key: 'download' }` to both `showLoading(...)` and the follow-up `showSuccess(...)` / `showError(...)`; antd replaces the toast in place instead of stacking. See `apps/agor-ui/src/components/WorktreeModal/tabs/FilesTab.tsx`.
- **Stable references.** The returned helpers (`showSuccess`, `showError`, etc.) are memoized over antd's stable `message` instance, so they're safe to put in `useCallback`/`useEffect` dep arrays without causing churn.

---

## Toast vs notification — the rule

Notifications aren't built yet. There's an in-flight design doc on the `design-notification-system` branch that codifies the split below; this file is the canonical source on the main branch until that lands.

> **Use a toast (`useThemedMessage`) when:**
> - The user just took an action and you're confirming it ("Saved", "Copied").
> - There's an error tied to the user's *current* action that won't be retried automatically.
> - The information has no value 5 minutes from now.
>
> **Use a notification when:**
> - The event happened *to* the user, not *because of* the user (an agent finished, a teammate tagged them).
> - The user might miss it because they're on another board / tab / device.
> - It needs to be actionable later, not just acknowledged now.

Until the notification system lands, **toast is the only option**, but flag durable-event toasts in PRs so they migrate later.

---

## Severity quick rules

- **Success** — confirms a user-initiated action that completed.
- **Error** — a failure tied to the user's current request. Default 6s so they can read + copy.
- **Warning** — a precondition wasn't met or a soft-failure path triggered ("Refresh token no longer valid — sign in again").
- **Info** — neutral status the user should see but not act on ("Retrying stop request…", "Complete sign-in in the new tab").
- **Loading** — pending state. Always pair with a `key` and a follow-up success/error using the same key.
