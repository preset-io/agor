// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Hand-rolled Slack-style chat stage for the "gateway" showcase scene.
//
// Deliberately NOT a pixel clone and NOT a third-party embed — just enough
// Slack visual grammar (dark aubergine sidebar, channel list, #eng-support
// header, square avatars, APP badge, rounded composer) that the left half of
// the split-screen instantly reads as "a Slack channel" while the right half
// (DemoSessionStage's gateway variant) shows the same message driving an Agor
// session. Everything is a pure function of the scene's virtual clock `t`:
//   uiFlags.slackPhase   0 = prior chatter · 1 = Sam's @Agor ping landed
//                        2 = the agent's reply posted back to the channel
//   textTracks.slackInput  char-by-char composer contents
//
// Colors are Slack-adjacent (aubergine #3F0E40, active-channel #1164A3,
// dark chat surface #1A1D21) without importing anything.

import type { SceneDefinition } from './timeline';

export const SLACK_STAGE_WIDTH = 1040;

const SIDEBAR_BG = '#3F0E40';
const SIDEBAR_TEXT = '#CFC3CF';
const ACTIVE_CHANNEL_BG = '#1164A3';
const MAIN_BG = '#1A1D21';
const BORDER = '#35373B';
const TEXT = '#D1D2D3';
const MUTED = '#ABABAD';
const MENTION = '#1D9BD1';
const SEND_GREEN = '#007A5A';

const FONT =
  'Lato, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const SidebarRow = ({ label, active = false }: { label: string; active?: boolean }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 16px 4px 26px',
      borderRadius: 6,
      margin: '0 8px',
      background: active ? ACTIVE_CHANNEL_BG : 'transparent',
      color: active ? '#ffffff' : SIDEBAR_TEXT,
      fontWeight: active ? 700 : 400,
      fontSize: 15,
      whiteSpace: 'nowrap',
    }}
  >
    <span style={{ opacity: active ? 1 : 0.7 }}>#</span>
    <span>{label}</span>
  </div>
);

const DmRow = ({ emoji, name, online }: { emoji: string; name: string; online: boolean }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 16px 3px 26px',
      color: SIDEBAR_TEXT,
      fontSize: 15,
    }}
  >
    <span
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        background: 'rgba(255,255,255,0.12)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
      }}
    >
      {emoji}
    </span>
    <span>{name}</span>
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: online ? '#2BAC76' : 'transparent',
        border: online ? 'none' : `1.5px solid ${SIDEBAR_TEXT}`,
        marginLeft: 'auto',
      }}
    />
  </div>
);

const SectionLabel = ({ label }: { label: string }) => (
  <div
    style={{
      padding: '14px 16px 6px',
      color: SIDEBAR_TEXT,
      fontSize: 14,
      fontWeight: 500,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}
  >
    <span style={{ fontSize: 9, opacity: 0.8 }}>▼</span>
    {label}
  </div>
);

interface SlackMessageProps {
  emoji: string;
  avatarBg: string;
  name: string;
  time: string;
  isApp?: boolean;
  children: React.ReactNode;
}

const SlackMessage = ({ emoji, avatarBg, name, time, isApp, children }: SlackMessageProps) => (
  <div style={{ display: 'flex', gap: 10, padding: '7px 20px', alignItems: 'flex-start' }}>
    <div
      style={{
        width: 38,
        height: 38,
        borderRadius: 6,
        flexShrink: 0,
        background: avatarBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 21,
      }}
    >
      {emoji}
    </div>
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ color: '#ffffff', fontWeight: 800, fontSize: 15 }}>{name}</span>
        {isApp && (
          <span
            style={{
              background: BORDER,
              color: MUTED,
              fontSize: 10,
              fontWeight: 700,
              padding: '1px 4px',
              borderRadius: 3,
              letterSpacing: '0.02em',
            }}
          >
            APP
          </span>
        )}
        <span style={{ color: MUTED, fontSize: 12 }}>{time}</span>
      </div>
      <div style={{ color: TEXT, fontSize: 15, lineHeight: 1.45, marginTop: 1 }}>{children}</div>
    </div>
  </div>
);

const Mention = ({ children }: { children: React.ReactNode }) => (
  <span
    style={{
      color: MENTION,
      background: 'rgba(29,155,209,0.12)',
      borderRadius: 3,
      padding: '0 2px',
    }}
  >
    {children}
  </span>
);

const InlineCode = ({ children }: { children: React.ReactNode }) => (
  <code
    style={{
      fontFamily: 'Monaco, Menlo, Consolas, monospace',
      fontSize: 13,
      color: '#E8809F',
      background: '#222529',
      border: `1px solid ${BORDER}`,
      borderRadius: 3,
      padding: '0 3px',
    }}
  >
    {children}
  </code>
);

interface DemoSlackStageProps {
  scene: SceneDefinition;
  t: number;
  /** The @Agor message Sam sends (also the session panel's inbound prompt). */
  prompt: string;
}

/** Left-docked, full-height Slack-style channel panel for the gateway scene. */
export const DemoSlackStage = ({ scene, t, prompt }: DemoSlackStageProps) => {
  const phaseTrack = scene.uiFlags.slackPhase;
  if (!phaseTrack) return null;
  const phase = Math.round(phaseTrack.sample(t));
  const inputText = scene.textTracks?.slackInput?.sample(t) ?? '';
  const hasInput = inputText.length > 0;

  // "@Agor rest-of-message" → highlighted mention + plain text.
  const promptRest = prompt.startsWith('@Agor') ? prompt.slice('@Agor'.length) : prompt;

  return (
    <div
      data-testid="demo-slack-stage"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 0,
        width: SLACK_STAGE_WIDTH,
        zIndex: 90,
        display: 'flex',
        fontFamily: FONT,
        boxShadow: '24px 0 70px rgba(0, 0, 0, 0.45)',
      }}
    >
      {/* Sidebar — aubergine, channel list */}
      <aside
        style={{
          width: 248,
          flexShrink: 0,
          background: SIDEBAR_BG,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ color: '#ffffff', fontWeight: 900, fontSize: 17 }}>Preset Eng ▾</span>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              background: '#ffffff',
              color: SIDEBAR_BG,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
            }}
          >
            ✎
          </span>
        </div>
        <div style={{ padding: '12px 16px 0', color: SIDEBAR_TEXT, fontSize: 15 }}>
          <div style={{ padding: '3px 0' }}>🧵 Threads</div>
          <div style={{ padding: '3px 0' }}>＠ Mentions &amp; reactions</div>
          <div style={{ padding: '3px 0' }}>📑 Drafts &amp; sent</div>
        </div>
        <SectionLabel label="Channels" />
        <SidebarRow label="general" />
        <SidebarRow label="deploys" />
        <SidebarRow label="design" />
        <SidebarRow label="eng-support" active />
        <SidebarRow label="incidents" />
        <SectionLabel label="Direct messages" />
        <DmRow emoji="🤖" name="Agor" online />
        <DmRow emoji="🧪" name="Rin" online />
        <DmRow emoji="🎨" name="Mina" online={false} />
      </aside>

      {/* Main channel column */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: MAIN_BG,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Channel header */}
        <div
          style={{
            flexShrink: 0,
            height: 56,
            borderBottom: `1px solid ${BORDER}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 20px',
          }}
        >
          <span style={{ color: '#ffffff', fontWeight: 900, fontSize: 18 }}># eng-support</span>
          <span style={{ color: MUTED, fontSize: 15 }}>☆</span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${BORDER}`,
              borderRadius: 5,
              padding: '3px 8px',
              color: MUTED,
              fontSize: 13,
            }}
          >
            <span style={{ fontSize: 13 }}>🧪⚡🤖</span> 24
          </span>
        </div>

        {/* Messages — bottom-anchored like a live channel */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            paddingBottom: 10,
          }}
        >
          {/* Day divider */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '0 20px 10px',
            }}
          >
            <div style={{ flex: 1, height: 1, background: BORDER }} />
            <span
              style={{
                border: `1px solid ${BORDER}`,
                borderRadius: 999,
                padding: '3px 12px',
                color: '#ffffff',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Today
            </span>
            <div style={{ flex: 1, height: 1, background: BORDER }} />
          </div>

          <SlackMessage emoji="🧪" avatarBg="#2F5D50" name="Rin" time="9:12 AM">
            staging deploy <InlineCode>#342</InlineCode> is live — smoke tests green.
          </SlackMessage>
          <SlackMessage emoji="🤖" avatarBg="#3D2E52" name="Agor" time="9:14 AM" isApp>
            Deploy summary posted — three e2e flakes, no product regressions.
          </SlackMessage>

          {phase >= 1 && (
            <SlackMessage emoji="⚡" avatarBg="#5D3A2F" name="Sam" time="9:41 AM">
              <Mention>@Agor</Mention>
              {promptRest}
            </SlackMessage>
          )}

          {phase >= 2 && (
            <SlackMessage emoji="🤖" avatarBg="#3D2E52" name="Agor" time="9:44 AM" isApp>
              Found it — last night’s deploy changed the OAuth redirect URL. Patched{' '}
              <InlineCode>oauth-config.ts</InlineCode> and redeployed staging ✅
            </SlackMessage>
          )}

          {phase === 1 && (
            <div style={{ padding: '6px 20px 0', color: MUTED, fontSize: 13, fontStyle: 'italic' }}>
              Agor is working on it…
            </div>
          )}
        </div>

        {/* Composer */}
        <div style={{ flexShrink: 0, padding: '0 20px 24px' }}>
          <div
            style={{
              border: '1px solid #565856',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '10px 12px',
                minHeight: 22,
                fontSize: 15,
                color: hasInput ? TEXT : MUTED,
                lineHeight: 1.45,
              }}
            >
              {hasInput ? inputText : 'Message #eng-support'}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '4px 8px 6px',
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.08)',
                  color: MUTED,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                }}
              >
                +
              </span>
              <span style={{ color: MUTED, fontSize: 13, fontWeight: 700 }}>Aa</span>
              <span style={{ color: MUTED, fontSize: 14 }}>😊</span>
              <span style={{ color: MUTED, fontSize: 14 }}>@</span>
              <span style={{ flex: 1 }} />
              <span
                data-testid="slack-send"
                style={{
                  width: 30,
                  height: 26,
                  borderRadius: 4,
                  background: hasInput ? SEND_GREEN : 'transparent',
                  color: hasInput ? '#ffffff' : MUTED,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 14,
                }}
              >
                ➤
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
