# Conversation Autocomplete

**Status:** ✅ Implemented (Nov 2025)
**Related:** [[conversation-ui]], [[frontend-guidelines]], [[files-service]]

---

## Overview

Prompt inputs support `@` autocomplete for files and users, matching Claude Code’s experience. Typing `@` opens a categorized popover:

- **Files:** Results from the worktree-aware `/files` service (path + type)
- **Users:** Team members filtered by name/email

Selecting an item inserts the path or mention directly into the textarea.

## Implementation Highlights

- UI component: `apps/agor-ui/src/components/AutocompleteTextarea/`
  - Debounced search, keyboard navigation, scrolling focus
  - ANSI-friendly insertion (quotes paths with spaces)
- Input wiring: `AutocompleteTextarea` is used by session drawers, Task modals, and subsession prompts.
- Data source: `apps/agor-daemon/src/services/files.ts` exposes fuzzy search scoped to the active session’s worktree.

## Usage

- Textarea placeholder reminds users: “type @ for autocomplete”.
- File selections insert repo-relative paths so agents can jump straight to files.
- User selections insert display name (`@alice`) for clear attribution in transcripts.

_Reference material: `context/archives/conversation-autocomplete.md`._
