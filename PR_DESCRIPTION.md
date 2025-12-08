# Screenshot Paste Support for Terminal UI

## Overview

This PR adds screenshot paste functionality to the Agor web terminal, bringing feature parity with Claude Code CLI.

## Demo

Users can now paste screenshots directly into the terminal with CMD+V (Mac) or Ctrl+V (Windows/Linux):

### Example 1: Terminal Path Insertion
![Terminal Path](docs/screenshots/terminal-path-insertion.png)

**Shows:** The pasted screenshot path appearing in the terminal input:
```
@".agor/uploads/Screenshot 2025-12-07 at 8.33.42â€"PM_1765157643226.png"
```

The file path is automatically inserted after paste, ready for the user to press Enter and have the AI analyze it.

### Example 2: AI Image Analysis
![AI Analysis](docs/screenshots/ai-analyzing-screenshot.png)

**Shows:** Claude analyzing the pasted screenshot and providing detailed analysis of a business process flow diagram showing payment processing scenarios.

**Complete workflow:**
1. User copies screenshot to clipboard (CMD+C / Ctrl+C)
2. User pastes in terminal (CMD+V / Ctrl+V)
3. Image uploads to `.agor/uploads/` in the worktree
4. File path automatically inserted into terminal input
5. User presses Enter
6. AI immediately analyzes the image and provides insights

## Features

✅ **Paste screenshots with keyboard shortcut** (CMD+V / Ctrl+V)
✅ **Automatic upload** to worktree `.agor/tmp/screenshots/`
✅ **File path auto-insertion** for immediate AI analysis
✅ **Visual feedback** (loading spinner during upload)
✅ **Security** (admin-only, JWT authenticated, MIME validation)
✅ **Docker compatible** (uses worktree bind mounts)
✅ **10MB file size limit** with validation
✅ **Supports PNG, JPEG, WEBP** formats

## Implementation Details

### Backend (`apps/agor-daemon`)

**New Service: `terminal-files.ts`**
- Handles multipart/form-data uploads via multer
- Validates image MIME types (PNG, JPEG, WEBP)
- Saves to `.agor/tmp/screenshots/` in worktree
- Returns relative paths for terminal use
- UUID-based filenames to prevent collisions
- Admin-role enforcement (matches terminal security)

**Modified: `index.ts`**
- Registers `/terminal-files` POST endpoint
- Custom JWT auth middleware for multipart uploads
- Integrates with existing worktree system

### Frontend (`apps/agor-ui`)

**Modified: `TerminalModal.tsx`**
- Window-level paste event listener
- ClipboardEvent handling for image detection
- FormData upload with fetch API
- Terminal.paste() integration for path insertion
- Ant Design Spin for loading state
- Error handling with user-friendly messages

## Testing

Tested in Docker environment on macOS:

- ✅ PNG screenshot paste
- ✅ JPEG screenshot paste
- ✅ Path auto-insertion
- ✅ AI image analysis
- ✅ Loading state UI
- ✅ Error handling (invalid file types)

## Files Changed

```
apps/agor-daemon/src/services/terminal-files.ts  (new, 180 lines)
apps/agor-daemon/src/index.ts                     (modified, +92 lines)
apps/agor-ui/src/components/TerminalModal/TerminalModal.tsx (modified, +93 lines)
```

**Total:** 365 additions, 3 deletions

## Migration Notes

No database migrations or config changes required. Feature is backward compatible.

## Security Considerations

- ✅ Admin-only access (worktree terminals already require admin)
- ✅ JWT authentication required
- ✅ MIME type validation (only image/* allowed)
- ✅ File size limit (10MB max)
- ✅ UUID-based filenames (no path traversal risk)
- ✅ Worktree isolation (files saved to worktree directory only)

## Example Use Case

**User workflow:**
1. User encounters an error in their code
2. Takes screenshot of error dialog/stack trace
3. Pastes screenshot into Agor terminal
4. Asks AI: "Can you analyze this error and suggest a fix?"
5. AI analyzes the screenshot and provides solution

**Before this PR:** User had to save screenshot manually, upload via file manager, then reference path
**After this PR:** User pastes screenshot directly, path auto-inserted

## Related Issues

Closes #[issue-number] (if applicable)

## Checklist

- [x] Code follows project style guidelines
- [x] Self-reviewed the code
- [x] Added inline comments for complex logic
- [x] Works in Docker environment
- [x] No breaking changes
- [x] Security considerations addressed
- [x] Feature tested manually
