'use client';

import {
  CircleDollarSign,
  Cpu,
  Ellipsis,
  GitFork,
  Hourglass,
  Paperclip,
  Plug,
  RotateCcw,
} from 'lucide-react';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import landing from '../LandingPage.module.css';
import { LandingLink } from './LandingLink';
import styles from './WorkTogetherDemo.module.css';

/**
 * Home-page "Work together again" demo (design handoff "work together demo").
 * Three teammates drag session cards onto a board, ask Agor about a feature,
 * ask a follow-up in someone else's card, then the session chrome falls away
 * and leaves three plain feature cards whose buttons link into /multiplayer.
 *
 * Everything derives from one clock, `t` (seconds, 0 → END): scene(t) is a
 * port of the prototype's scene() and is the source of truth for timing and
 * geometry. Plays when the section is 30% visible and skips to the end state
 * under reduced motion. Leaving the viewport mid-play starts it over next
 * time; once it has settled it stays settled (Play again replays it), so the
 * board never grows back under a reader who has scrolled past.
 */

const END = 13;
// The timeline is authored at 1×; play it 20% slower so cursors and typing
// read at a human pace (13s of scene ≈ 16s on screen).
const PLAYBACK_RATE = 0.8;
// Design-space board, scaled to fit its container.
const BOARD_W = 1200;
const BOARD_H = 700;
// Once the cards have collapsed, the board eases down to fit them, with the
// CTA just below the cards and Play again under it, so the section doesn't
// leave dead space (the harness strip moves into view). Then the three
// cursors gather on the CTA, click it together, and leave together.
const SETTLE_AT = 9.3;
const CTA_IN: [number, number] = [9.6, 10.2];
const GATHER_AT = 9.8; // first cursor sets off for the CTA; the others follow
const GATHER_STAGGER = 0.2;
const GATHER_TRAVEL = 0.8;
const CLICK_AT = 11.4;
const LEAVE: [number, number] = [11.9, 12.5];
const BOARD_H_SETTLED = 440;
const CTA_Y = 336;
const REPLAY_Y = 404;

const USERS = [
  { label: 'Maya', color: '#f5a3c7', name: 'Maya' },
  { label: 'Ari', color: '#6fdcf0', name: 'Ari' },
  { label: 'Sam', color: '#f2d27a', name: 'Sam' },
];

const CARDS = [
  {
    q: 'How do we see who’s working on what?',
    title: 'Live presence',
    body: 'Cursors, comments, and live sessions as work happens, all on the same board.',
    follow: 'Where do I learn more?',
    btn: 'See live presence',
    anchor: 'live-presence',
  },
  {
    q: 'Can QA test my branch without their own setup?',
    title: 'Shared dev environments',
    body: 'Engineers, reviewers, PMs, and QA rally around the same branches and builds. No more “spin up your own.”',
    follow: 'What’s the best link for this?',
    btn: 'Open a shared env',
    anchor: 'shared-environments',
  },
  {
    q: 'How do I learn which prompts actually work?',
    title: 'Learn from each other',
    body: 'Watch how teammates prompt, standardize what works, and build a shared knowledge base as you go.',
    follow: 'Build a landing page for this',
    btn: 'Open the landing page',
    anchor: 'learn-together',
  },
];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => (v < 0.5 ? 2 * v * v : 1 - (-2 * v + 2) ** 2 / 2);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

function scene(T: number) {
  const seg = (a: number, b: number) => clamp01((T - a) / (b - a));
  const typed = (s: string, a: number, b: number) => s.slice(0, Math.round(s.length * seg(a, b)));
  const H0 = 540;
  const H1 = 250;
  const FX = [20, 420, 820];
  const FY = 30;
  const S = [
    [-540, 0],
    [0, 640],
    [540, 0],
  ];
  const CX = [5.0, 5.6, 6.2];
  const clean = ease(seg(8.2, 9.2));
  const k = 1 - clean;
  const H = lerp(H0, H1, clean);
  const inp = (i: number) => [FX[i] + 70, FY + H0 - 79];
  const below = (i: number) => [FX[i] + 250, FY + H + 36];
  const grip = [180, 14];

  const cards = CARDS.map((c, i) => {
    const a = 0.2 + 0.3 * i;
    const dp = ease(seg(a, a + 0.8));
    const dragging = T > a && dp < 1;
    const own = USERS[i];
    const cross = USERS[(i + 1) % 3];
    const qA = 1.2 + 0.45 * i;
    const qB = qA + 1.1;
    const ans = qB + 0.6;
    const cA = CX[i];
    const cB = cA + 1.0;
    let inText = 'Queue here… @ for mentions';
    let typist = '';
    if (T >= qA && T < qB + 0.1) {
      inText = typed(c.q, qA, qB);
      typist = own.color;
    } else if (T >= cA && T < cB + 0.1) {
      inText = typed(c.follow, cA, cB);
      typist = cross.color;
    }
    const qShown = T >= qB + 0.1;
    const fShown = T >= cB + 0.1;
    const thinking = qShown && T < ans;
    const bs = ease(seg(cB + 0.4, cB + 0.7));
    return {
      ...c,
      owner: own,
      cross,
      x: FX[i] + (1 - dp) * S[i][0],
      dy: (1 - dp) * S[i][1],
      dragging,
      h: H,
      visible: T >= a,
      chrome: k,
      qShown,
      qOp: seg(qB + 0.1, qB + 0.3) * k,
      thinking,
      dots: [0, 1, 2].map((d) => 0.3 + 0.7 * Math.max(0, Math.sin(T * 8 - d * 0.8))),
      titleShown: T >= ans,
      titleP: seg(ans, ans + 0.3),
      body: typed(c.body, ans + 0.15, ans + 1.6),
      metaShown: T >= ans + 1.6,
      metaOp: seg(ans + 1.6, ans + 1.9) * k,
      fShown,
      fOp: seg(cB + 0.1, cB + 0.3) * k,
      btnP: bs,
      live: T >= SETTLE_AT,
      typing: typist !== '',
      typist,
      inText,
      caret: typist !== '' && Math.floor(T * 3) % 2 === 0,
      running:
        (thinking || (T >= ans && T < ans + 1.6) || (T >= cB + 0.1 && T < cB + 0.6)) && k > 0.5,
      timer: `00:${String(Math.max(0, Math.floor((T - (T >= cB ? cB : qB)) * 4))).padStart(2, '0')}`,
      ctx: 12 + i * 5 + (T >= ans ? 6 : 0) + (T >= cB ? 3 : 0),
      meta: {
        time: `00:0${6 + i}`,
        tokens: [48, 61, 53][i],
        sha: ['32c825d', 'a91f0e4', '7be3c12'][i],
      },
    };
  });

  // Cursor path between waypoints. A right-handed mouse pivots around the
  // wrist/elbow, below and right of the cursor, so moves arc: the path bows
  // up and to the left (away from the pivot) by up to ARC of its length.
  // Timing starts brisk and settles slowly (velocity peaks early). A
  // waypoint flagged STRAIGHT ends a drag: the cursor is holding a card that
  // moves in a straight line, so that leg doesn't arc.
  const ARC = 0.14;
  const handEase = (v: number) => ease(v ** 0.8);
  const at = (kf: number[][]) => {
    if (T <= kf[0][0]) return [kf[0][1], kf[0][2]];
    for (let j = 1; j < kf.length; j++) {
      if (T <= kf[j][0]) {
        const [t0, x0, y0] = kf[j - 1];
        const [t1, x1, y1, straight] = kf[j];
        const d = t1 - t0;
        const raw = d > 0 ? (T - t0) / d : 1;
        const p = straight ? ease(raw) : handEase(raw);
        let x = lerp(x0, x1, p);
        let y = lerp(y0, y1, p);
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        if (!straight && len > 4) {
          // Unit normal to the move, flipped to point away from the pivot.
          let nx = -dy / len;
          let ny = dx / len;
          if (nx + ny > 0) {
            nx = -nx;
            ny = -ny;
          }
          const bulge = ARC * len * 4 * raw * (1 - raw);
          x += nx * bulge;
          y += ny * bulge;
        }
        return [x, y];
      }
    }
    const last = kf[kf.length - 1];
    return [last[1], last[2]];
  };
  const STRAIGHT = 1;

  // Gather order: whoever finished their follow-up first heads over first.
  const finishOrder = [0, 1, 2].sort((x, y) => CX[(x + 2) % 3] - CX[(y + 2) % 3]);
  // Cursor tips on the CTA (its center is 600, CTA_Y), spread so the name
  // chips don't stack.
  const ctaTips = [
    [535, CTA_Y - 6],
    [600, CTA_Y + 6],
    [665, CTA_Y - 2],
  ];

  const cursors = USERS.map((u, i) => {
    const a = 0.2 + 0.3 * i;
    const qA = 1.2 + 0.45 * i;
    const qB = qA + 1.1;
    const c = (i + 2) % 3;
    const Cx = CX[c];
    const rank = finishOrder.indexOf(i);
    const go = GATHER_AT + GATHER_STAGGER * rank;
    const tip = ctaTips[rank];
    const start = [FX[i] + S[i][0] + grip[0], FY + S[i][1] + grip[1]];
    const home = [FX[i] + grip[0], FY + grip[1]];
    const [x, y] = at([
      [0, ...start],
      [a, ...start],
      [a + 0.8, ...home, STRAIGHT],
      [qA - 0.1, ...inp(i)],
      [qB + 0.1, ...inp(i)],
      [qB + 0.6, ...below(i)],
      [Cx - 0.6, ...below(i)],
      [Cx - 0.05, ...inp(c)],
      [Cx + 1.1, ...inp(c)],
      [Cx + 1.6, ...below(c)],
      [go, ...below(c)],
      [go + GATHER_TRAVEL, ...tip],
      [CLICK_AT + 0.4, ...tip],
      [LEAVE[1], tip[0] + 40 + (rank - 1) * 30, tip[1] + 110],
    ]);
    const wobble = Math.sin(T * 1.3 + i * 2) * 3;
    return {
      ...u,
      x: x + wobble,
      y: y + wobble * 0.6,
      op: 1 - seg(LEAVE[0], LEAVE[1]),
      press: T >= CLICK_AT && T < CLICK_AT + 0.2,
    };
  });

  // One click from each cursor, at its own tip, in its own color.
  const pulses =
    T >= CLICK_AT && T < CLICK_AT + 0.8
      ? finishOrder.map((i, rank) => {
          const q = seg(CLICK_AT, CLICK_AT + 0.8);
          return {
            i,
            x: ctaTips[rank][0] + 4,
            y: ctaTips[rank][1] + 4,
            s: 0.3 + q * 1.4,
            op: 1 - q,
            color: USERS[i].color,
          };
        })
      : [];

  const present = cursors.filter((c) => c.op > 0.5).length;
  return {
    cards,
    cursors,
    pulses,
    ctaP: seg(...CTA_IN),
    ctaLive: T >= CTA_IN[1],
    ctaPressed: T >= CLICK_AT && T < CLICK_AT + 0.25,
    ctaRing: T >= CLICK_AT ? 6 * (1 - seg(CLICK_AT + 0.15, CLICK_AT + 1)) : 0,
    liveOp: 1 - seg(LEAVE[0] + 0.1, LEAVE[1]),
    liveLabel:
      present === 1
        ? '1 person on this board'
        : present
          ? `${present} people on this board`
          : 'Board ready',
    replayOp: seg(12.8, 13),
    settled: T >= SETTLE_AT,
  };
}

function Bubble({ text, color, initials }: { text: string; color: string; initials: string }) {
  return (
    <div className={styles.bubbleRow}>
      <div className={styles.bubble}>{text}</div>
      <div className={styles.avatar} style={{ background: color }}>
        {initials}
      </div>
    </div>
  );
}

const initials = (name: string) => name.slice(0, 2).toUpperCase();

export function WorkTogetherDemo() {
  const [t, setT] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [scale, setScale] = useState(1);
  const sectionRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const clock = useRef({ t: 0, playing: false, raf: 0 });

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width) setScale(entry.contentRect.width / BOARD_W);
    });
    observer.observe(board);
    return () => observer.disconnect();
  }, []);

  // One rAF clock, repainting at ~30fps and stopping once the timeline ends.
  const play = () => {
    const c = clock.current;
    if (c.playing) return;
    c.playing = true;
    let last = performance.now();
    let lastPaint = 0;
    const frame = (now: number) => {
      c.t = Math.min(END, c.t + Math.min(0.1, (now - last) / 1000) * PLAYBACK_RATE);
      last = now;
      if (now - lastPaint > 33 || c.t >= END) {
        lastPaint = now;
        setT(c.t);
      }
      if (c.t < END && c.playing) c.raf = requestAnimationFrame(frame);
      else c.playing = false;
    };
    c.raf = requestAnimationFrame(frame);
  };

  const reset = () => {
    const c = clock.current;
    cancelAnimationFrame(c.raf);
    c.playing = false;
    c.t = 0;
    setT(0);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: play/reset only touch refs and setT
  useEffect(() => {
    if (reduced) return;
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= 0.3) play();
        // Before the settle the board's height hasn't changed, so starting
        // over is free; after it, re-growing would shove the page down.
        else if (!entry.isIntersecting && clock.current.t < SETTLE_AT) reset();
      },
      { threshold: [0, 0.3] }
    );
    observer.observe(section);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(clock.current.raf);
      clock.current.playing = false;
    };
  }, [reduced]);

  const s = scene(reduced ? END : t);

  // The settle changes the board's height. If the reader has scrolled so the
  // board's top is off screen, apply it at once and scroll by the same amount,
  // so what they're looking at (further down) doesn't move.
  const lastHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const board = boardRef.current;
    const height = scale * (s.settled ? BOARD_H_SETTLED : BOARD_H);
    const previous = lastHeight.current;
    lastHeight.current = height;
    if (!board || previous === null || previous === height) return;
    if (board.getBoundingClientRect().top >= 0) return;
    board.style.transition = 'none';
    void board.offsetHeight;
    window.scrollBy(0, height - previous);
    requestAnimationFrame(() => {
      board.style.transition = '';
    });
  }, [s.settled, scale]);

  return (
    <div className={styles.demo} ref={sectionRef} data-troupe-section="work-together">
      <div className={styles.head}>
        <div>
          <h2 className={landing.liveStatement}>
            Work <span className={landing.headingStrong}>together</span>{' '}
            <span className={landing.headingAccent}>again</span>
          </h2>
          <p className={landing.liveSub}>
            One shared board instead of ten private terminals.
            <br />
            <span className={landing.headingDim}>
              Bring your team and agents together on one live,{' '}
              <span className={landing.headingAccent}>multiplayer canvas</span>.
            </span>
          </p>
        </div>
        <div className={styles.livePill} style={{ opacity: s.liveOp }} aria-hidden="true">
          <span className={styles.liveDot} />
          {s.liveLabel}
        </div>
      </div>

      <div
        className={styles.board}
        ref={boardRef}
        data-troupe="wt-board"
        style={{ height: scale * (s.settled ? BOARD_H_SETTLED : BOARD_H) }}
      >
        <div
          className={styles.stage}
          style={{
            width: BOARD_W,
            height: s.settled ? BOARD_H_SETTLED : BOARD_H,
            transform: `scale(${scale})`,
          }}
        >
          {s.cards.map((c) => (
            <div
              key={c.title}
              className={styles.card}
              style={
                {
                  left: c.x,
                  height: c.h,
                  opacity: c.visible ? 1 : 0,
                  transform: `translateY(${c.dy}px) scale(${c.dragging ? 1.03 : 1})`,
                  borderColor: `rgba(63, 217, 196, ${c.dragging ? 0.5 : 0.2})`,
                  boxShadow: c.dragging
                    ? '0 40px 80px rgba(0, 0, 0, 0.5)'
                    : '0 20px 50px rgba(0, 0, 0, 0.5)',
                } as CSSProperties
              }
            >
              <div className={styles.cardTop} aria-hidden={!c.live}>
                <div
                  className={styles.sessionHead}
                  style={{
                    maxHeight: 20 * c.chrome,
                    marginBottom: 12 * c.chrome,
                    opacity: c.chrome,
                  }}
                >
                  <span className={styles.ownerDot} style={{ background: c.owner.color }} />
                  {c.owner.name}’s session
                </div>
                <div
                  className={styles.collapsible}
                  style={{
                    maxHeight: c.qShown ? 90 * c.chrome : 0,
                    marginBottom: c.qShown ? 12 * c.chrome : 0,
                    opacity: c.qOp,
                  }}
                >
                  <Bubble text={c.q} color={c.owner.color} initials={initials(c.owner.name)} />
                </div>
                <div
                  className={styles.thinking}
                  style={{ height: c.thinking ? 26 : 0, opacity: c.thinking ? 1 : 0 }}
                >
                  {c.dots.map((d, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed three dots
                    <span key={i} style={{ opacity: d }} />
                  ))}
                </div>
                <h3
                  className={styles.title}
                  style={{ opacity: c.titleP, transform: `translateY(${(1 - c.titleP) * 8}px)` }}
                >
                  {c.titleShown ? c.title : ''}
                </h3>
                <p className={styles.body}>{c.body}</p>
                <div
                  className={styles.meta}
                  style={{
                    maxHeight: c.metaShown ? 20 * c.chrome : 0,
                    marginTop: c.metaShown ? 8 * c.chrome : 0,
                    opacity: c.metaOp,
                  }}
                >
                  ✓ {c.meta.time} · ⚡ {c.meta.tokens} · <GitFork size={10} aria-hidden />{' '}
                  {c.meta.sha}
                  <span className={styles.dirty} />
                </div>
                <div
                  className={styles.collapsible}
                  style={{
                    maxHeight: c.fShown ? 60 * c.chrome : 0,
                    marginTop: c.fShown ? 12 * c.chrome : 0,
                    opacity: c.fOp,
                  }}
                >
                  <Bubble text={c.follow} color={c.cross.color} initials={initials(c.cross.name)} />
                </div>
              </div>
              <div className={styles.cardBottom}>
                <div
                  className={styles.btnRow}
                  style={{ opacity: c.btnP, transform: `scale(${0.9 + 0.1 * c.btnP})` }}
                >
                  <LandingLink
                    page="multiplayer"
                    anchor={c.anchor}
                    placement="home-section"
                    className={styles.cardBtn}
                    style={{ pointerEvents: c.live ? 'auto' : 'none' }}
                    tabIndex={c.live ? undefined : -1}
                  >
                    {c.btn}
                  </LandingLink>
                </div>
                <div
                  className={styles.composerWrap}
                  style={{ height: 104 * c.chrome, marginTop: 12 * c.chrome, opacity: c.chrome }}
                  aria-hidden="true"
                >
                  <div className={styles.composer}>
                    <div className={styles.chips}>
                      {c.running && (
                        <span className={`${styles.chip} ${styles.chipTimer}`}>
                          <Hourglass size={10} aria-hidden /> {c.timer}
                        </span>
                      )}
                      <span className={styles.chip}>
                        <Plug size={10} aria-hidden /> MCP 0
                      </span>
                      <span className={styles.chip}>
                        <Cpu size={10} aria-hidden /> sonnet-5
                      </span>
                      <span className={styles.chip}>
                        <CircleDollarSign size={11} aria-hidden />
                      </span>
                      <span className={`${styles.chip} ${styles.chipCtx}`}>{c.ctx}%</span>
                    </div>
                    <div className={`${styles.input}${c.typing ? ` ${styles.inputTyping}` : ''}`}>
                      <span
                        className={styles.typistDot}
                        style={{ background: c.typist || 'transparent' }}
                      />
                      <span className={c.typing ? styles.inputText : styles.placeholder}>
                        {c.inText}
                      </span>
                      <span
                        className={styles.caret}
                        style={{ background: c.typist, opacity: c.caret ? 1 : 0 }}
                      />
                    </div>
                    <div className={styles.actions}>
                      <span className={styles.icons}>
                        <Paperclip size={14} aria-hidden />
                        <GitFork size={14} aria-hidden />
                        <Ellipsis size={14} aria-hidden />
                      </span>
                      <span className={styles.actionBtns}>
                        {c.running && <span className={styles.stop}>Stop</span>}
                        <span
                          className={`${styles.send}${c.typing ? ` ${styles.sendActive}` : ''}`}
                        >
                          Send
                        </span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {s.pulses.map((p) => (
            <span
              key={p.i}
              className={styles.pulse}
              style={{
                left: p.x - 30,
                top: p.y - 30,
                borderColor: p.color,
                opacity: p.op,
                transform: `scale(${p.s})`,
              }}
              aria-hidden="true"
            />
          ))}

          {s.cursors.map((c, index) =>
            c.op > 0 ? (
              <div
                key={c.name}
                // The home page's cursor troupe follows these and stands in
                // for them (hidden via html[data-troupe-wt]); see CursorTroupe.
                data-troupe-cursor={index}
                data-pressed={c.press ? '' : undefined}
                className={styles.cursor}
                style={{
                  transform: `translate(${c.x}px, ${c.y}px) scale(${c.press ? 0.85 : 1})`,
                  opacity: c.op,
                }}
                aria-hidden="true"
              >
                <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    d="M2 1l15 8-7 1.6L7 18z"
                    fill={c.color}
                    stroke="#061010"
                    strokeWidth="1.2"
                  />
                </svg>
                <span className={styles.cursorName} style={{ background: c.color }}>
                  {c.label}
                </span>
              </div>
            ) : null
          )}

          <LandingLink
            page="multiplayer"
            placement="home-section"
            className={styles.cta}
            style={{
              top: CTA_Y,
              opacity: s.ctaP,
              background: s.ctaPressed ? 'rgba(63, 217, 196, 0.28)' : undefined,
              boxShadow: s.ctaRing
                ? `0 0 0 ${s.ctaRing}px rgba(63, 217, 196, 0.3), 0 20px 60px rgba(0, 0, 0, 0.45)`
                : undefined,
              transform: `translate(-50%, calc(-50% + ${(1 - ease(s.ctaP)) * 12}px))`,
              pointerEvents: s.ctaLive ? 'auto' : 'none',
            }}
            tabIndex={s.ctaLive ? undefined : -1}
          >
            Explore Multiplayer AI
          </LandingLink>
          {!reduced && (
            <button
              type="button"
              className={styles.replay}
              style={{
                top: REPLAY_Y,
                opacity: s.replayOp * 0.8,
                pointerEvents: s.replayOp > 0 ? 'auto' : 'none',
              }}
              tabIndex={s.replayOp > 0 ? undefined : -1}
              onClick={() => {
                reset();
                play();
              }}
            >
              <RotateCcw size={14} aria-hidden />
              Play again
            </button>
          )}
        </div>
      </div>

      {/* Narrow screens: the settled end state as a plain stack (the animated
          board needs desktop width; a phone version is a later pass). */}
      <div className={styles.stack}>
        {CARDS.map((c) => (
          <div key={c.title} className={styles.stackCard}>
            <h3 className={styles.title}>{c.title}</h3>
            <p className={styles.body}>{c.body}</p>
            <LandingLink
              page="multiplayer"
              anchor={c.anchor}
              placement="home-section"
              className={styles.cardBtn}
            >
              {c.btn}
            </LandingLink>
          </div>
        ))}
        <LandingLink page="multiplayer" placement="home-section" className={styles.stackCta}>
          Explore Multiplayer AI <span aria-hidden="true">→</span>
        </LandingLink>
      </div>
    </div>
  );
}
