# UI modal rendering audit

## Findings

- The UI uses a mix of conditional rendering and always-mounted custom modal components with a
  controlled `open` prop. Ant Design does not create a modal's portal contents before its first
  open by default, but an eagerly rendered custom wrapper still runs its hooks, and modal contents
  normally remain mounted after the first close unless destroyed.
- Canvas zone configuration/deletion, artifact consent, environment logs, new-session, and several
  session-canvas dialogs were already rendered only while their backing state exists.
- Branch cards and their repeated session sections eagerly mounted archive and fork/spawn modal
  wrappers for every card. Settings card/artifact tables and the canvas card-detail modal also kept
  inactive modal trees mounted.
- Some forms explicitly use `destroyOnHidden={false}`. Those retain inactive panel/form state on
  purpose and were not changed.

## Changes

- Branch-card archive/delete and per-card fork/spawn modals now mount only when opened.
- Canvas card details now mount only when a card is selected.
- Card-type create/edit, settings card details, and artifact edit forms now mount on demand and
  unmount on close. Their close handlers already reset the relevant form/selection state.
- Added a focused branch-card regression test covering mount-on-open and removal-on-close.
- Modal wrappers stay mounted through Ant Design's exit motion and unmount from `afterClose`, so
  render-on-open does not bypass the component's close lifecycle.

## Deliberately unchanged

- App-level settings, user settings, onboarding, and other singleton controlled modals remain
  declarative. They occur once rather than per canvas item, and changing their lifecycle could reset
  intentionally retained navigation or draft state.
- Confirmation APIs and lightweight singleton dialogs were left alone; they do not create repeated
  hidden component trees.
- Components with explicit state-retention comments or `destroyOnHidden={false}` were preserved.

## Recommended convention

For rare or heavy dialogs, especially within lists/canvas nodes, keep separate mounted-entity and
visibility state. Mount the custom modal on demand, pass its controlled `open` prop, set `open=false`
to begin closing, and clear the mounted entity from `afterClose`. This avoids eager wrapper hooks and
form state without bypassing Ant Design's exit motion or close lifecycle. If the wrapper must remain
mounted, use Ant Design's `destroyOnHidden` when state retention is not desired. Keep a closed modal
mounted only when preserving a draft or expensive live resource is intentional and documented.
