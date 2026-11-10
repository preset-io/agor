// Hand-rolled chat surfaces for the "talk to it from anywhere" section:
// Slack, Discord and Claude Desktop. Like the website's Slack stage
// (apps/agor-ui/src/pages/marketing/DemoSlackStage.tsx), these are NOT
// pixel clones and use no third-party logos or assets: just enough of each
// product's visual grammar (layout, palette, message shape) to read as that
// app at a glance. Each is drawn at STAGE_W x STAGE_H and driven by `t`
// (seconds into the section).

import type React from 'react';

// Small canvas, so each app's conversation fills its panel at a readable size.
export const STAGE_W = 900;
export const STAGE_H = 506;

/** Seconds: the question lands, the "working" state, the reply lands. */
export interface ChatBeats {
  askAt: number;
  replyAt: number;
}

const ROWS: [string, string][] = [
  ['Sam', 'SAASY-377 invoice rounding: #309 merged'],
  ['Ada', 'SAASY-412 route time windows: #318 draft'],
  ['Grace', 'SAASY-398 QuickBooks retry: #315 changes requested'],
  ['Kai', 'SAASY-405 offline queue cap: #317 waiting on Sam'],
];

export const QUESTION = "what's the team working on right now?";

const fadeUp = (t: number, at: number): React.CSSProperties => {
  const p = Math.max(0, Math.min(1, (t - at) / 0.25));
  return { opacity: p, translate: `0px ${(1 - p) * 14}px` };
};

const Rows: React.FC<{ color: string; muted: string; t: number; at: number }> = ({
  color,
  muted,
  t,
  at,
}) => (
  <div style={{ marginTop: 4 }}>
    {ROWS.map(([who, what], i) => (
      <div key={who} style={{ ...fadeUp(t, at + i * 0.08), color, lineHeight: 1.5 }}>
        <b>{who}</b> <span style={{ color: muted }}>·</span> {what}
      </div>
    ))}
  </div>
);

// ─── Slack ────────────────────────────────────────────────────────────────

const SLACK = {
  sidebar: '#3F0E40',
  sidebarText: '#CFC3CF',
  active: '#1164A3',
  main: '#1A1D21',
  border: '#35373B',
  text: '#D1D2D3',
  muted: '#ABABAD',
  mention: '#1D9BD1',
};

const SlackMsg: React.FC<{
  emoji: string;
  bg: string;
  name: string;
  time: string;
  app?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ emoji, bg, name, time, app, style, children }) => (
  <div style={{ display: 'flex', gap: 12, padding: '8px 24px', ...style }}>
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 7,
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 24,
        flexShrink: 0,
      }}
    >
      {emoji}
    </div>
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: '#fff', fontWeight: 800, fontSize: 18 }}>{name}</span>
        {app ? (
          <span
            style={{
              background: SLACK.border,
              color: SLACK.muted,
              fontSize: 11,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
            }}
          >
            APP
          </span>
        ) : null}
        <span style={{ color: SLACK.muted, fontSize: 14 }}>{time}</span>
      </div>
      <div style={{ color: SLACK.text, fontSize: 18, lineHeight: 1.45 }}>{children}</div>
    </div>
  </div>
);

export const SlackStage: React.FC<{ t: number; beats: ChatBeats }> = ({ t, beats }) => (
  <div
    style={{
      width: STAGE_W,
      height: STAGE_H,
      display: 'flex',
      fontFamily: 'Lato, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
    }}
  >
    <aside
      style={{ width: 270, background: SLACK.sidebar, color: SLACK.sidebarText, fontSize: 17 }}
    >
      <div
        style={{
          padding: '16px 18px',
          color: '#fff',
          fontWeight: 900,
          fontSize: 20,
          borderBottom: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        SaaSy Co. ▾
      </div>
      <div style={{ padding: '14px 18px 6px', fontWeight: 600 }}>▾ Channels</div>
      {['general', 'deploys', 'eng', 'incidents'].map((c) => (
        <div
          key={c}
          style={{
            margin: '0 10px',
            padding: '5px 18px',
            borderRadius: 6,
            background: c === 'eng' ? SLACK.active : 'transparent',
            color: c === 'eng' ? '#fff' : SLACK.sidebarText,
            fontWeight: c === 'eng' ? 700 : 400,
          }}
        >
          # {c}
        </div>
      ))}
      <div style={{ padding: '14px 18px 6px', fontWeight: 600 }}>▾ Apps</div>
      <div style={{ padding: '5px 28px' }}>🛠️ EngBot</div>
    </aside>
    <main style={{ flex: 1, background: SLACK.main, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          height: 62,
          borderBottom: `1px solid ${SLACK.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 24px',
          color: '#fff',
          fontWeight: 900,
          fontSize: 21,
        }}
      >
        # eng
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          paddingBottom: 14,
        }}
      >
        <SlackMsg emoji="🧾" bg="#2F5D50" name="Grace" time="9:58 AM">
          pushed the retry fix, review when you can 🙏
        </SlackMsg>
        <SlackMsg emoji="⚡" bg="#5D3A2F" name="Sam" time="10:02 AM" style={fadeUp(t, beats.askAt)}>
          <span
            style={{ color: SLACK.mention, background: 'rgba(29,155,209,0.12)', borderRadius: 3 }}
          >
            @EngBot
          </span>{' '}
          {QUESTION}
        </SlackMsg>
        {t >= beats.askAt + 0.3 && t < beats.replyAt ? (
          <div
            style={{
              padding: '4px 24px 0 78px',
              color: SLACK.muted,
              fontSize: 15,
              fontStyle: 'italic',
            }}
          >
            EngBot is working on it…
          </div>
        ) : null}
        {t >= beats.replyAt ? (
          <SlackMsg
            emoji="🛠️"
            bg="#2b4a74"
            name="EngBot"
            time="10:02 AM"
            app
            style={fadeUp(t, beats.replyAt)}
          >
            Here's the team right now:
            <Rows color={SLACK.text} muted={SLACK.muted} t={t} at={beats.replyAt + 0.1} />
          </SlackMsg>
        ) : null}
      </div>
      <div
        style={{
          margin: '0 24px 22px',
          border: '1px solid #565856',
          borderRadius: 9,
          padding: '12px 14px',
          color: SLACK.muted,
          fontSize: 17,
        }}
      >
        Message #eng
      </div>
    </main>
  </div>
);

// ─── Discord ──────────────────────────────────────────────────────────────

const DISCORD = {
  rail: '#1E1F22',
  sidebar: '#2B2D31',
  main: '#313338',
  text: '#DBDEE1',
  muted: '#949BA4',
  blurple: '#5865F2',
  mention: '#C9CDFB',
};

const DiscordMsg: React.FC<{
  avatar: string;
  bg: string;
  name: string;
  nameColor: string;
  bot?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ avatar, bg, name, nameColor, bot, style, children }) => (
  <div style={{ display: 'flex', gap: 16, padding: '8px 20px', ...style }}>
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 22,
        flexShrink: 0,
      }}
    >
      {avatar}
    </div>
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: nameColor, fontWeight: 600, fontSize: 18 }}>{name}</span>
        {bot ? (
          <span
            style={{
              background: DISCORD.blurple,
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 4,
            }}
          >
            ✓ APP
          </span>
        ) : null}
        <span style={{ color: DISCORD.muted, fontSize: 13 }}>Today at 10:02 AM</span>
      </div>
      <div style={{ color: DISCORD.text, fontSize: 18, lineHeight: 1.45 }}>{children}</div>
    </div>
  </div>
);

export const DiscordStage: React.FC<{ t: number; beats: ChatBeats }> = ({ t, beats }) => (
  <div
    style={{
      width: STAGE_W,
      height: STAGE_H,
      display: 'flex',
      fontFamily: '"gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
    }}
  >
    <nav
      style={{
        width: 78,
        background: DISCORD.rail,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        paddingTop: 14,
      }}
    >
      {['💬', '🛰️', '🎮', '🌱'].map((g, i) => (
        <div
          key={g}
          style={{
            width: 50,
            height: 50,
            borderRadius: i === 1 ? 16 : '50%',
            background: i === 1 ? DISCORD.blurple : DISCORD.main,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 22,
          }}
        >
          {g}
        </div>
      ))}
    </nav>
    <aside style={{ width: 170, background: DISCORD.sidebar, color: DISCORD.muted, fontSize: 17 }}>
      <div
        style={{
          height: 62,
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          color: '#fff',
          fontWeight: 700,
          fontSize: 18,
          boxShadow: '0 1px 0 rgba(0,0,0,0.25)',
        }}
      >
        SaaSy Co. Builders
      </div>
      <div
        style={{ padding: '16px 16px 6px', fontSize: 13, fontWeight: 700, letterSpacing: '0.02em' }}
      >
        TEXT CHANNELS
      </div>
      {['welcome', 'help', 'engineering', 'releases'].map((c) => (
        <div
          key={c}
          style={{
            margin: '1px 8px',
            padding: '6px 10px',
            borderRadius: 5,
            background: c === 'engineering' ? 'rgba(78,80,88,0.6)' : 'transparent',
            color: c === 'engineering' ? '#fff' : DISCORD.muted,
          }}
        >
          # {c}
        </div>
      ))}
    </aside>
    <main style={{ flex: 1, background: DISCORD.main, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          height: 62,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          color: '#fff',
          fontWeight: 700,
          fontSize: 19,
          boxShadow: '0 1px 0 rgba(0,0,0,0.25)',
        }}
      >
        <span style={{ color: DISCORD.muted, marginRight: 8 }}>#</span>engineering
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          paddingBottom: 14,
        }}
      >
        <DiscordMsg avatar="🌀" bg="#3ba55c" name="ada" nameColor="#57F287">
          route optimizer draft is up 🚚
        </DiscordMsg>
        <DiscordMsg
          avatar="🎧"
          bg="#eb459e"
          name="kai"
          nameColor="#EB459E"
          style={fadeUp(t, beats.askAt)}
        >
          <span
            style={{
              color: DISCORD.mention,
              background: 'rgba(88,101,242,0.3)',
              borderRadius: 3,
              padding: '0 2px',
            }}
          >
            @EngBot
          </span>{' '}
          {QUESTION}
        </DiscordMsg>
        {t >= beats.askAt + 0.3 && t < beats.replyAt ? (
          <div style={{ padding: '4px 20px 0 80px', color: DISCORD.muted, fontSize: 15 }}>
            <b style={{ color: DISCORD.text }}>EngBot</b> is typing…
          </div>
        ) : null}
        {t >= beats.replyAt ? (
          <DiscordMsg
            avatar="🛠️"
            bg={DISCORD.blurple}
            name="EngBot"
            nameColor="#fff"
            bot
            style={fadeUp(t, beats.replyAt)}
          >
            Here's the team right now:
            <Rows color={DISCORD.text} muted={DISCORD.muted} t={t} at={beats.replyAt + 0.1} />
          </DiscordMsg>
        ) : null}
      </div>
      <div
        style={{
          margin: '0 20px 22px',
          background: '#383A40',
          borderRadius: 9,
          padding: '13px 16px',
          color: DISCORD.muted,
          fontSize: 17,
        }}
      >
        Message #engineering
      </div>
    </main>
  </div>
);

// ─── Claude Desktop ───────────────────────────────────────────────────────

const CLAUDE = {
  sidebar: '#1F1E1D',
  main: '#262624',
  card: '#30302E',
  border: '#3D3D3A',
  text: '#E8E6DC',
  muted: '#A6A39A',
  accent: '#D97757',
};

export const ClaudeDesktopStage: React.FC<{ t: number; beats: ChatBeats }> = ({ t, beats }) => {
  const toolAt = beats.askAt + 0.45;
  return (
    <div
      style={{
        width: STAGE_W,
        height: STAGE_H,
        display: 'flex',
        background: CLAUDE.main,
        fontFamily: '"Styrene B", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
      }}
    >
      <aside
        style={{
          width: 250,
          background: CLAUDE.sidebar,
          color: CLAUDE.muted,
          fontSize: 16,
          padding: '18px 14px',
        }}
      >
        <div style={{ color: CLAUDE.text, fontWeight: 600, fontSize: 18, marginBottom: 18 }}>
          ✳ Claude
        </div>
        <div
          style={{
            color: CLAUDE.text,
            padding: '7px 10px',
            borderRadius: 8,
            background: CLAUDE.card,
          }}
        >
          ✎ New chat
        </div>
        <div style={{ marginTop: 18, fontSize: 13, letterSpacing: '0.03em' }}>RECENTS</div>
        {['Team standup notes', 'Q4 planning', 'SAASY roadmap'].map((r) => (
          <div key={r} style={{ padding: '7px 10px' }}>
            {r}
          </div>
        ))}
      </aside>
      <main
        style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 36px 16px' }}
      >
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            gap: 16,
          }}
        >
          <div
            style={{
              ...fadeUp(t, beats.askAt),
              alignSelf: 'flex-end',
              background: CLAUDE.card,
              color: CLAUDE.text,
              padding: '12px 18px',
              borderRadius: 14,
              fontSize: 19,
              maxWidth: 640,
            }}
          >
            Ask EngBot in Agor {QUESTION}
          </div>
          {t >= toolAt ? (
            <div
              style={{
                ...fadeUp(t, toolAt),
                border: `1px solid ${CLAUDE.border}`,
                borderRadius: 10,
                padding: '10px 14px',
                color: CLAUDE.muted,
                fontSize: 16,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: 'fit-content',
              }}
            >
              <span style={{ color: CLAUDE.accent }}>⚙</span>
              <span style={{ color: CLAUDE.text }}>agor</span> › agor_sessions_prompt
              <span style={{ marginLeft: 8 }}>{t >= beats.replyAt ? '✓' : '…'}</span>
            </div>
          ) : null}
          {t >= beats.replyAt ? (
            <div
              style={{
                ...fadeUp(t, beats.replyAt),
                color: CLAUDE.text,
                fontSize: 19,
                lineHeight: 1.5,
              }}
            >
              EngBot says the team is on:
              <Rows color={CLAUDE.text} muted={CLAUDE.muted} t={t} at={beats.replyAt + 0.1} />
            </div>
          ) : null}
        </div>
        <div
          style={{
            marginTop: 18,
            border: `1px solid ${CLAUDE.border}`,
            borderRadius: 16,
            padding: '16px 18px',
            color: CLAUDE.muted,
            fontSize: 17,
            background: CLAUDE.card,
          }}
        >
          Reply to Claude…
        </div>
      </main>
    </div>
  );
};
