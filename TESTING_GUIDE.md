# Slack Gateway Testing Guide

## Overview

This guide walks through testing the expanded Slack gateway functionality with all the new configuration options.

---

## Prerequisites

### Slack App Setup

1. **Create a Slack App** at https://api.slack.com/apps
2. **Add OAuth Bot Token Scopes** (OAuth & Permissions page):
   - `chat:write` (required)
   - `channels:history` (for public channels)
   - `groups:history` (for private channels)
   - `mpim:history` (for group DMs)
   - `app_mentions:read` (recommended for mentions)

3. **Subscribe to Bot Events** (Event Subscriptions page):
   - `message.im` (required)
   - `message.channels` (for public channels)
   - `message.groups` (for private channels)
   - `message.mpim` (for group DMs)
   - `app_mention` (recommended for mentions)

4. **Enable Socket Mode** (Socket Mode page):
   - Enable Socket Mode
   - Generate an App-Level Token with `connections:write` scope
   - Copy the token (starts with `xapp-`)

5. **Install to Workspace**:
   - Install the app to your Slack workspace
   - Copy the Bot User OAuth Token (starts with `xoxb-`)

---

## Test Scenarios

### Scenario 1: DM-Only (Default Behavior)

**Config:**
```json
{
  "enable_channels": false,
  "enable_groups": false,
  "enable_mpim": false,
  "require_mention": true
}
```

**Expected Behavior:**
- ✅ Bot responds to direct messages
- ❌ Bot ignores mentions in public channels
- ❌ Bot ignores mentions in private channels
- ❌ Bot ignores mentions in group DMs

**Test Steps:**
1. Create a new gateway channel with default settings (all switches off)
2. DM the bot directly → Should respond
3. Mention bot in a public channel → Should not respond
4. Check daemon logs: Should see "Skipping public channel message (not enabled in config)"

---

### Scenario 2: Public Channels Enabled

**Config:**
```json
{
  "enable_channels": true,
  "enable_groups": false,
  "enable_mpim": false,
  "require_mention": true
}
```

**Expected Behavior:**
- ✅ Bot responds to direct messages
- ✅ Bot responds when @mentioned in public channels
- ❌ Bot ignores non-mentioned messages in public channels
- ❌ Bot ignores mentions in private channels

**Test Steps:**
1. Edit gateway channel, enable "Enable Public Channels"
2. Save and wait for daemon to reload
3. Add bot to a public channel
4. Send message without mention → Should not respond
5. Send message with @botname → Should respond (with mention stripped)
6. Check agent receives text without @botname in it

---

### Scenario 3: All Sources Enabled, Mention Required

**Config:**
```json
{
  "enable_channels": true,
  "enable_groups": true,
  "enable_mpim": true,
  "require_mention": true
}
```

**Expected Behavior:**
- ✅ Bot responds to DMs (no mention needed)
- ✅ Bot responds when @mentioned in public channels
- ✅ Bot responds when @mentioned in private channels
- ✅ Bot responds when @mentioned in group DMs
- ❌ Bot ignores non-mentioned messages in channels/groups

**Test Steps:**
1. Enable all three message source switches
2. Keep "Require Bot Mention" ON
3. Test mention in public channel → Responds
4. Test mention in private channel → Responds
5. Test mention in group DM → Responds
6. Test non-mention in channel → Ignores

---

### Scenario 4: All Sources, No Mention Required ⚠️

**Config:**
```json
{
  "enable_channels": true,
  "enable_groups": true,
  "enable_mpim": true,
  "require_mention": false
}
```

**Expected Behavior:**
- ✅ Bot responds to ALL messages in enabled sources
- ⚠️ Very noisy! Will respond to every message.

**Test Steps:**
1. Enable all sources, disable "Require Bot Mention"
2. Should see warning in UI about responding to ALL messages
3. Send any message in public channel (no mention) → Bot responds
4. **Important:** This is for testing only! Not recommended for production.

---

### Scenario 5: Channel Whitelist

**Config:**
```json
{
  "enable_channels": true,
  "allowed_channel_ids": ["C01ABC123XY"]
}
```

**Expected Behavior:**
- ✅ Bot responds in whitelisted channel
- ❌ Bot ignores mentions in non-whitelisted channels

**Test Steps:**
1. Get channel ID from Slack (right-click channel → View details → bottom)
2. Add channel ID to whitelist in Advanced section
3. Mention bot in whitelisted channel → Responds
4. Mention bot in different channel → Ignores
5. Check logs: "Skipping message from non-whitelisted channel"

---

### Scenario 6: Multiple Channels with Different Configs

**Setup:**
- Channel A: DM-only (default)
- Channel B: Public channels enabled
- Channel C: All sources, no mention required (specific channel whitelist)

**Test:**
1. Create three separate gateway channels
2. Configure each differently
3. Test that each behaves independently
4. Verify sessions are created in correct worktrees

---

## Debugging

### Enable Verbose Logging

The connector logs extensively. Look for these patterns:

**On startup:**
```
[slack] Bot user ID: U01ABC123XY
[slack] Message source config: { enableChannels: true, ... }
```

**On message received:**
```
[slack] Received event type="events_api" subtype="message"
[slack] Processing public channel message (enabled in config)
[slack] Bot was mentioned, stripped mention from text
[slack] Inbound message: thread=C01...-1707... channel_type=channel ...
```

**When filtering:**
```
[slack] Skipping public channel message (not enabled in config)
[slack] Skipping message from non-whitelisted channel C01...
[slack] Skipping channel message without bot mention
```

### Common Issues

**Bot not responding at all:**
- Check Socket Mode is enabled in Slack app
- Verify app token is correct
- Check daemon logs for connection errors
- Verify gateway channel is enabled in UI

**Bot not responding in channels:**
- Verify "Enable Public Channels" is toggled ON
- Check bot has `channels:history` scope
- Verify `message.channels` event subscription
- Check bot is added to the channel

**Mention detection not working:**
- Check daemon logs for "Bot user ID: U..."
- If missing, bot token may be invalid
- Verify bot has `app_mentions:read` scope
- Try re-saving the channel config

**Bot responding to own messages:**
- Should be filtered by `bot_id` check
- If not, check bot token vs user token

---

## Success Criteria

- ✅ DM-only mode works (backward compatible)
- ✅ Public channels work when enabled
- ✅ Private channels work when enabled
- ✅ Group DMs work when enabled
- ✅ Mention requirement is enforced
- ✅ Mention is stripped from prompt text
- ✅ Channel whitelist filters correctly
- ✅ Multiple channels with different configs work independently
- ✅ Bot doesn't respond to its own messages
- ✅ Sessions are created in correct worktrees
- ✅ Thread continuity works (follow-ups go to same session)

---

## Performance Notes

- **Auth test API call:** Made once on startup per channel (cached)
- **Message filtering:** All filtering happens in-memory (no DB calls)
- **Config loading:** Read once on listener startup
- **Regex matching:** Used for mention detection (efficient)

---

## Next Steps After Testing

1. ✅ Verify all test scenarios pass
2. ✅ Check daemon logs for errors
3. ✅ Monitor session creation and routing
4. 📚 Update user-facing documentation
5. 🚀 Deploy to production
