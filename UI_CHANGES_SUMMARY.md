# Gateway Channel Settings UI - What's New

## Before

**Slack Configuration Section:**
```
Platform Configuration
├── Bot Token (xoxb-...)
├── App Token (xapp-...)
└── Connection Mode [Socket Mode / Webhook]
```

Only these 3 fields. No way to configure where the bot listens.

---

## After ✨

**Slack Configuration Section:**
```
Platform Configuration
├── Bot Token (xoxb-...)
├── App Token (xapp-...)
└── Connection Mode [Socket Mode / Webhook]

────────────────────────────────
Message Sources
────────────────────────────────

ℹ️ Choose where the bot should listen for messages
   Direct messages are always enabled. Enable additional
   sources carefully — see security documentation.

☐ Enable Public Channels
   Bot will respond to messages in public channels it's added to

☐ Enable Private Channels
   Bot will respond to messages in private channels it's added to

☐ Enable Group DMs
   Bot will respond to messages in multi-person direct messages

☑ Require Bot Mention
   When enabled, bot only responds when explicitly @mentioned
   (recommended for channels)

[Conditional Alerts - shown when options are enabled:]

⚠️  Bot will respond to ALL messages
    With 'Require Bot Mention' disabled, the bot will respond
    to every message in enabled channels/groups...

ℹ️  Required Slack OAuth Scopes
    • chat:write (always required)
    • channels:history - Read public channel messages
    • app_mentions:read - Receive mention events
    • groups:history - Read private channel messages
    • mpim:history - Read group DM messages

ℹ️  Required Slack Event Subscriptions
    • message.im (always required)
    • message.channels - Public channel messages
    • app_mention - Bot mention events (recommended)
    • message.groups - Private channel messages
    • message.mpim - Group DM messages

▼ Advanced: Channel Whitelist

  Optionally restrict the bot to specific Slack channels
  by ID. Leave empty to allow all channels where the bot
  is added.

  [Add channel IDs... (e.g., C01ABC123XY)]

  ℹ️ Whitelist applies to all message sources
```

---

## Key Features

### 🎯 Dynamic Alerts
- Alerts appear/disappear based on selected options
- Shows exactly which OAuth scopes are needed
- Shows exactly which event subscriptions are needed
- Warns when unsafe configurations are selected

### 🔒 Security First
- All new options default to `false` (DM-only)
- "Require Bot Mention" defaults to `true`
- Clear warnings when expanding bot access
- Channel whitelist for granular control

### 📊 Form Behavior
- **Create Mode:** All fields appear, new channels start with safe defaults
- **Edit Mode:** Existing values populate, including new config fields
- **Smart Defaults:** Missing config fields default to DM-only (backward compatible)

### 🎨 Visual Clarity
- Divider separates credentials from message sources
- Conditional alerts only show when relevant
- Collapse for advanced options (channel whitelist)
- Tooltips on every field

---

## Technical Implementation

**Data Flow:**
```
User toggles switches
    ↓
Form.useWatch detects changes
    ↓
Conditional alerts render/hide
    ↓
User clicks Save
    ↓
extractFormData() packages values
    ↓
Stored in gateway_channels.config JSON blob
    ↓
Backend connector reads config (Phase 2)
```

**Storage:**
```typescript
// Stored in gateway_channels.config (JSON column)
{
  bot_token: "xoxb-...",
  app_token: "xapp-...",
  connection_mode: "socket",
  enable_channels: false,        // NEW
  enable_groups: false,          // NEW
  enable_mpim: false,            // NEW
  require_mention: true,         // NEW
  allowed_channel_ids: []        // NEW
}
```

**No database migration needed!** The `config` column is already a flexible JSON blob.

---

## User Experience

### Creating a New Channel
1. User clicks "Add Channel"
2. Fills in name, worktree, tokens (existing flow)
3. Sees new "Message Sources" section with all options disabled
4. Can optionally enable channels/groups/DMs
5. Sees real-time alerts showing required scopes and events
6. Saves channel with chosen configuration

### Editing an Existing Channel
1. User clicks "Edit" on a channel
2. Existing settings populate (including new fields, defaulting to false)
3. User can toggle message sources on/off
4. Conditional alerts update in real-time
5. Channel whitelist can be added/modified
6. Saves updates

### Backward Compatibility
- Existing channels without new config fields default to DM-only
- No breaking changes
- Users opt-in to expanded functionality

---

## Next Steps (Backend - Phase 2)

The UI is complete. Backend needs to:

1. ✅ Read config fields from `gateway_channels.config`
2. ✅ Respect `enable_channels`, `enable_groups`, `enable_mpim` flags
3. ✅ Check `require_mention` and filter accordingly
4. ✅ Apply `allowed_channel_ids` whitelist
5. ✅ Strip bot mention from text before sending to agent
6. ✅ Test all combinations

See `SLACK_SCOPE_IMPLEMENTATION.md` for detailed backend implementation guide.
