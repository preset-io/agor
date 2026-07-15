/**
 * Centralized external links for agor-docs.
 *
 * Update DISCORD_INVITE_URL here when the invite link changes.
 * NOTE: Markdown files (*.md, *.mdx) also reference this URL
 * and must be updated separately via find-replace.
 */

export const DISCORD_INVITE_URL = 'https://discord.gg/Qh4TrFQZpd';
export const GITHUB_REPO_URL = 'https://github.com/preset-io/agor';

// UTM suffix for links into preset.io, so Preset's Google Analytics can
// attribute traffic coming from Agor surfaces. Append per placement via
// `presetUtm(<placement>)`; utm_content carries the placement slug.
// JSON-LD organization URLs deliberately stay clean — schema.org URLs are
// entity identifiers, not navigation.
const PRESET_UTM_BASE = 'utm_source=agor.live&utm_medium=referral&utm_campaign=agor-docs';
export const presetUtm = (content: string, hasQuery = false): string =>
  `${hasQuery ? '&' : '?'}${PRESET_UTM_BASE}&utm_content=${content}`;

// Preset home — used by the footer credit (logo + text link).
export const PRESET_URL = 'https://preset.io';

// Agor Cloud private beta interest form (Preset landing page, replaces
// the legacy Google Forms link). Consumed by CloudInviteCTA in the
// agor-cloud blog post. Note: agor-openclaw.mdx still has an inline
// link to the legacy Google Forms URL and is not updated here.
export const AGOR_CLOUD_INVITE_URL = `https://preset.io/contact-us-about-agor/${presetUtm('cloud-invite-cta')}`;

// Agor Cloud demo / contact link (HubSpot meetings scheduler).
export const AGOR_CLOUD_DEMO_URL =
  'https://meetings.hubspot.com/zane-aitken/agor-cloud-sign-up-link-';

// Preset blog post defining the AI Enablement Engineer — Agor's target
// persona. Linked from landing-page copy.
export const AI_ENABLEMENT_POST_URL = `https://preset.io/blog/ai-enablement-engineer/${presetUtm('ai-enablement-post')}`;
