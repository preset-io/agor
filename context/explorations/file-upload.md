# File Upload in Conversations

**Status:** Exploration (Proposed)
**Related:** [conversation-ui.md](../concepts/conversation-ui.md), [worktrees.md](../concepts/worktrees.md)

---

## Overview

Allow users to upload files directly into a conversation, making them accessible to the agent. Files land in the worktree at `.agor/uploads/` by default, enabling multimodal interactions (images, documents, code snippets, etc.).

### What This Adds

**New backend endpoint:** `POST /sessions/:id/upload` with multer middleware

**New UI components:**

- Upload button next to prompt textarea
- Drag-and-drop zone on textarea
- Upload dialog with destination selection
- Optional agent notification with custom message

**Key features:**

- Any file type accepted (multimodal-ready)
- Files accessible via existing `@` autocomplete
- Optional system message in conversation ("User uploaded file: ...")
- Optional agent notification with attached notes

---

## Motivation

### Why Build This?

**1. Multimodal Workflows**

- Share screenshots for UI feedback
- Upload error logs for debugging
- Provide reference documents for context
- Share design mockups, diagrams, specs

**2. Natural Interaction**

- "Here's what I'm seeing" + screenshot is intuitive
- Reduces friction vs. manual file placement + path typing
- Drag-drop matches modern app expectations

**3. Agent Accessibility**

- Files land in worktree = agent can read them
- `.agor/uploads/` is predictable, agent-friendly location
- Works with existing `@` mention autocomplete

---

## Design Decisions

### File Storage Location

**Primary destination:** `{worktree.path}/.agor/uploads/`

| Location           | Path                             | Use Case                           |
| ------------------ | -------------------------------- | ---------------------------------- |
| Worktree (default) | `{worktree.path}/.agor/uploads/` | Agent-accessible, can be committed |
| Temp               | `$TMPDIR/agor-uploads/`          | Ephemeral, auto-cleanup            |
| Global             | `~/.agor/uploads/`               | Shared across sessions             |

**Rationale for worktree default:**

- Agent always has access (it's running in the worktree)
- User can commit if desired (though `.agor/` typically gitignored)
- Clear mental model: "files for this work"

### Filename Handling

- **Preserve original filename** - User recognition, easy `@` mention
- **Overwrite on duplicate** - Simplest behavior, no timestamp clutter
- **No sanitization beyond security** - Keep spaces, unicode, etc.

### File Type Policy

- **Accept all file types** - Agents are multimodal
- **Size limit:** 50MB (configurable)
- **No MIME validation** - Trust user intent

---

## UI Design

### Entry Points

**1. Upload button** - Paperclip icon next to send button

```
+---------------------------------------------------------------+
| [Attach] Send a prompt... (type @ for files)    [Fork] [Send] |
+---------------------------------------------------------------+
```

**2. Drag-and-drop** - Drop files anywhere on textarea

Visual feedback on drag-over:

```
+---------------------------------------------------------------+
|  +---------------------------+                                |
|  |  Drop files here          |  (dashed border, highlight)    |
|  +---------------------------+                                |
+---------------------------------------------------------------+
```

### Upload Dialog

Triggered when files are selected (via button or drop):

```
+-- Upload File(s) --------------------------------------------+
|                                                              |
|  Selected: screenshot.png (2.3 MB)                           |
|                                                              |
|  Destination:                                                |
|    (*) Worktree (.agor/uploads/)     <- default              |
|    ( ) Temp folder                                           |
|    ( ) Global (~/.agor/uploads/)                             |
|                                                              |
|  [ ] Notify the agent about this file                        |
|                                                              |
|  +--------------------------------------------------------+  |
|  | Please review this screenshot located at               |  |
|  | {filepath}                                             |  |
|  |                                                        |  |  <- visible when checked
|  +--------------------------------------------------------+  |
|  (placeholder shows filepath template)                       |
|                                                              |
|                               [Cancel]  [Upload]             |
+--------------------------------------------------------------+
```

### Post-Upload Behavior

1. File lands in selected destination
2. If "notify agent" checked:
   - Send prompt with user's message
   - `{filepath}` replaced with actual path
3. If not checked:
   - Optional: Insert `@{filepath}` at cursor in textarea
   - User can reference file in their next message
4. Optional system message in conversation: "Uploaded: screenshot.png"

---

## Technical Implementation

### Backend: Multer Configuration

```typescript
// apps/agor-daemon/src/middleware/upload.ts
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';

const storage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    const { sessionId } = req.params;
    const destination = req.body.destination || 'worktree';

    const session = await sessionRepo.findById(sessionId);
    const worktree = await worktreeRepo.findById(session.worktree_id);

    const paths: Record<string, string> = {
      worktree: path.join(worktree.path, '.agor', 'uploads'),
      temp: path.join(os.tmpdir(), 'agor-uploads'),
      global: path.join(os.homedir(), '.agor', 'uploads'),
    };

    const dest = paths[destination] || paths.worktree;
    await fs.mkdir(dest, { recursive: true });
    cb(null, dest);
  },

  filename: (_req, file, cb) => {
    // Preserve original filename, overwrite duplicates
    cb(null, file.originalname);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});
```

### Backend: Upload Endpoint

```typescript
// apps/agor-daemon/src/index.ts (or new route file)

app.post(
  '/sessions/:sessionId/upload',
  authenticateSession,
  upload.array('files', 10), // Max 10 files per request
  async (req, res) => {
    const { sessionId } = req.params;
    const { notifyAgent, message } = req.body;
    const files = req.files as Express.Multer.File[];

    const uploadedFiles = files.map(f => ({
      filename: f.originalname,
      path: f.path,
      size: f.size,
      mimeType: f.mimetype,
    }));

    // Optionally send prompt to agent
    if (notifyAgent && message) {
      const filePaths = uploadedFiles.map(f => f.path).join(', ');
      const prompt = message.replace(/\{filepath\}/g, filePaths);
      await promptSession(sessionId, prompt);
    }

    // Optionally emit system event for conversation
    // app.service('messages').emit('system', { ... });

    res.json({
      success: true,
      files: uploadedFiles,
    });
  }
);
```

### Frontend: Upload Component

```typescript
// apps/agor-ui/src/components/FileUpload/FileUpload.tsx

interface FileUploadProps {
  sessionId: string;
  onUploadComplete: (files: UploadedFile[]) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ sessionId, onUploadComplete }) => {
  const [files, setFiles] = useState<File[]>([]);
  const [destination, setDestination] = useState<'worktree' | 'temp' | 'global'>('worktree');
  const [notifyAgent, setNotifyAgent] = useState(false);
  const [message, setMessage] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  const handleUpload = async () => {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    formData.append('destination', destination);
    formData.append('notifyAgent', String(notifyAgent));
    formData.append('message', message);

    setIsUploading(true);
    const response = await fetch(`/sessions/${sessionId}/upload`, {
      method: 'POST',
      body: formData,
    });
    const result = await response.json();
    setIsUploading(false);

    onUploadComplete(result.files);
  };

  // ... render dialog
};
```

### Frontend: Drag-Drop Integration

```typescript
// Extend AutocompleteTextarea or SessionPanel

const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault();
  setIsDragOver(true);
};

const handleDragLeave = () => {
  setIsDragOver(false);
};

const handleDrop = (e: React.DragEvent) => {
  e.preventDefault();
  setIsDragOver(false);

  const droppedFiles = Array.from(e.dataTransfer.files);
  if (droppedFiles.length > 0) {
    openUploadDialog(droppedFiles);
  }
};
```

---

## Future Enhancements

### Uploaded Files Tracking (Optional)

Could add metadata tracking for better UX:

```typescript
// New table: uploaded_files
interface UploadedFile {
  file_id: UUID;
  session_id: SessionID;
  worktree_id: WorktreeID;
  filename: string;
  path: string;
  size: number;
  mime_type: string;
  uploaded_at: Date;
  uploaded_by: UserID;
}
```

**Enables:**

- "Uploaded files" panel in session/worktree UI
- File browser with download/delete actions
- Usage analytics

**Trade-off:** Metadata can go stale if agent moves/deletes files.

### Conversation System Messages

Show upload events in conversation:

```
+-- System Message --------------------------------+
|  User uploaded: screenshot.png                   |
|  Location: .agor/uploads/screenshot.png          |
+--------------------------------------------------+
```

### Clipboard Paste Support

```typescript
const handlePaste = (e: React.ClipboardEvent) => {
  const items = e.clipboardData.items;
  const imageItems = Array.from(items).filter(i => i.type.startsWith('image/'));

  if (imageItems.length > 0) {
    const files = imageItems.map(i => i.getAsFile()).filter(Boolean);
    openUploadDialog(files);
  }
};
```

---

## Implementation Phases

### Phase 1: MVP

- [ ] Add multer dependency
- [ ] Create upload endpoint (worktree destination only)
- [ ] Upload button component
- [ ] Basic upload dialog (no destination choice)
- [ ] Insert `@{filepath}` into textarea after upload

### Phase 2: Full Dialog

- [ ] Destination selection (worktree/temp/global)
- [ ] "Notify agent" checkbox + message textarea
- [ ] Drag-and-drop on textarea

### Phase 3: Polish

- [ ] Upload progress indicator
- [ ] Multi-file upload UI
- [ ] Clipboard paste support
- [ ] System messages in conversation

### Phase 4: Optional Enhancements

- [ ] Uploaded files metadata table
- [ ] Files panel in session UI
- [ ] Cleanup automation for temp files

---

## Dependencies

**New packages:**

- `multer` - Multipart form handling
- `@types/multer` - TypeScript types

**Estimated effort:**

- Phase 1: 4-6 hours
- Phase 2: 2-3 hours
- Phase 3: 2-3 hours
- Phase 4: 4-6 hours (if pursued)
