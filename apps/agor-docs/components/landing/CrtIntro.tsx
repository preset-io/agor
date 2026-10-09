'use client';

import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { CRT_INTRO_ATTR, crtIntroState } from '../../lib/crtIntro';
import styles from './CrtIntro.module.css';

/*
 * The home page's optional "locked" intro (?intro=true; see lib/crtIntro.ts):
 * an amber-phosphor terminal types out the problem (working alone, in a
 * terminal), and Enter, a tap, or a click powers the CRT off. It collapses to
 * a bright dot, the page fades in behind it, and the cursor troupe bursts out
 * of the dot into the hero while the logo assembles.
 *
 * The text is drawn on a 2D canvas and shown through a WebGL CRT pass:
 * curved glass, scanlines, bloom, RGB shift, a rolling beam, noise, flicker,
 * and a vignette. Without WebGL it's the same words in styled DOM text; under
 * reduced motion there's no typing, noise, or power-off animation.
 */

const AMBER = '#ffb347';
const AMBER_DIM = '#9a6a2c';
// The one aqua thing on the screen: the way out.
const AQUA = '#45e0c8';

interface Segment {
  text: string;
  color: string;
  /** Seconds to wait before this segment starts typing. */
  pause: number;
  /** Characters per second; 0 = appears at once. */
  cps: number;
}

type Line = Segment[];

function lastLogin(): string {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'short' });
  const month = now.toLocaleDateString('en-US', { month: 'short' });
  const time = now.toLocaleTimeString('en-GB', { hour12: false });
  return `Last login: ${day} ${month} ${String(now.getDate()).padStart(2, ' ')} ${time} on ttys001`;
}

function script(touch: boolean): Line[] {
  const say = (text: string, pause: number, color = AMBER): Segment => ({
    text,
    color,
    pause,
    cps: 26,
  });
  return [
    [{ text: lastLogin(), color: AMBER_DIM, pause: 0.5, cps: 0 }],
    [],
    [say('Is this what work looks like now?', 0.6)],
    [],
    [say('Spending your day typing into a terminal?', 0.9), say(' Alone?', 0.9)],
    [],
    [say('This isn’t what the future should feel like.', 1.1)],
    [],
    [
      { text: '> ', color: AMBER, pause: 1.1, cps: 0 },
      { text: touch ? 'Tap' : 'Press Enter', color: AMBER, pause: 0.15, cps: 34 },
      { text: ' to enable ', color: AMBER, pause: 0, cps: 34 },
      { text: 'Multiplayer AI', color: AQUA, pause: 0, cps: 34 },
    ],
  ];
}

const plainText = (lines: Line[]) =>
  lines.map((line) => line.map((segment) => segment.text).join(''));

interface Glyph {
  ch: string;
  col: number;
  row: number;
  color: string;
  /** Seconds after start when it appears. */
  at: number;
}

/** Monospace layout: word-wrap each line to `cols`, and time every glyph. */
function layout(lines: Line[], cols: number, reduced: boolean) {
  const glyphs: Glyph[] = [];
  let row = 0;
  let clock = 0;
  for (const line of lines) {
    // Wrap on the whole line's text first, so words never jump while typing.
    const chars: Array<{ ch: string; color: string; seg: number; i: number }> = [];
    line.forEach((segment, seg) => {
      for (let i = 0; i < segment.text.length; i++) {
        chars.push({ ch: segment.text[i], color: segment.color, seg, i });
      }
    });
    const places: Array<{ col: number; row: number }> = [];
    let col = 0;
    for (let k = 0; k < chars.length; k++) {
      if (chars[k].ch !== ' ' && (k === 0 || chars[k - 1].ch === ' ')) {
        let end = k;
        while (end < chars.length && chars[end].ch !== ' ') end++;
        if (col > 0 && col + (end - k) > cols) {
          row++;
          col = 0;
        }
      }
      if (col === 0 && chars[k].ch === ' ' && k > 0) {
        places.push({ col: -1, row });
        continue;
      }
      places.push({ col, row });
      col++;
    }
    let lastSeg = -1;
    chars.forEach((c, k) => {
      const segment = line[c.seg];
      if (c.seg !== lastSeg) {
        clock += segment.pause;
        lastSeg = c.seg;
      }
      if (segment.cps > 0) clock += (1 / segment.cps) * (0.55 + Math.random() * 0.9);
      if (places[k].col >= 0) {
        glyphs.push({ ...c, ...places[k], at: reduced ? 0 : clock });
      }
    });
    row++;
  }
  return { glyphs, rows: row, done: reduced ? 0 : clock };
}

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uPower;
uniform float uMotion;
uniform float uDpr;
varying vec2 vUv;

float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 off = abs(uv.yx) / vec2(5.5, 4.5);
  uv = uv + uv * off * off;
  return uv * 0.5 + 0.5;
}

vec3 tex(vec2 uv) { return texture2D(uTex, uv).rgb; }

void main() {
  vec2 uv = curve(vUv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Power: 0 = off, 1 = on. Off collapses the picture to a line, then a dot.
  float sx = max(smoothstep(0.0, 0.35, uPower), 0.003);
  float sy = max(smoothstep(0.3, 1.0, uPower), 0.004);
  vec2 c = (uv - 0.5) / vec2(sx, sy) + 0.5;
  float inside = step(0.0, c.x) * step(c.x, 1.0) * step(0.0, c.y) * step(c.y, 1.0);

  float t = uTime;
  float glitch = step(0.985, rand(vec2(floor(t * 12.0), 1.0))) * uMotion;
  c.x += (sin(c.y * 90.0 + t * 4.0) * 0.0004 + glitch * 0.004 * sin(c.y * 30.0 + t * 50.0)) * uMotion;

  vec2 px = 1.0 / uRes;
  float shift = 1.2 * uDpr * px.x;
  vec3 col = vec3(tex(c + vec2(shift, 0.0)).r, tex(c).g, tex(c - vec2(shift, 0.0)).b);

  vec3 bloom = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 d = vec2(cos(a), sin(a));
    bloom += tex(c + d * px * 3.0 * uDpr);
    bloom += tex(c + d * px * 7.0 * uDpr) * 0.6;
  }
  col += bloom * 0.075;
  col += vec3(0.035, 0.022, 0.01);

  float scan = 0.5 + 0.5 * cos(6.28318 * gl_FragCoord.y / (3.0 * uDpr));
  col *= mix(0.66, 1.0, scan);

  float beamY = 1.0 - fract(t * 0.11);
  col += vec3(0.06, 0.04, 0.02) * exp(-pow((c.y - beamY) * 26.0, 2.0)) * uMotion;
  col += (rand(uv * uRes + t) - 0.5) * 0.05 * uMotion;
  col *= 1.0 - 0.025 * uMotion * (0.5 + 0.5 * sin(t * 120.0));
  col *= pow(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.28);
  col *= inside;

  // Brightens as it collapses, mostly at the very end (a thin hot line).
  float flare = pow(1.0 - uPower, 3.0);
  col = col * (1.0 + flare * 3.0) + inside * flare * vec3(1.0, 0.85, 0.6) * 0.9;
  float spot = exp(-length((uv - 0.5) * vec2(uRes.x / uRes.y, 1.0)) * 40.0);
  col += vec3(1.0, 0.9, 0.75) * spot * (1.0 - smoothstep(0.0, 0.25, uPower)) * step(0.001, uPower);
  col *= smoothstep(0.0, 0.02, uPower);
  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/** Power-on, power-off, and the fade that hands over to the page (ms). */
const POWER_ON_MS = 450;
const POWER_OFF_MS = 560;
const FADE_MS = 700;

export function CrtIntro() {
  const [mode, setMode] = useState<'off' | 'gl' | 'plain'>('off');
  const [leaving, setLeaving] = useState(false);
  const [touch, setTouch] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const leaveRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (crtIntroState() !== 'locked') return;
    window.scrollTo(0, 0);
    setTouch(window.matchMedia('(hover: none)').matches);
    const probe = document.createElement('canvas').getContext('webgl');
    setMode(probe ? 'gl' : 'plain');
  }, []);

  // Enter, Space, Escape, or a click/tap anywhere (the button covers it all).
  useEffect(() => {
    if (mode === 'off') return;
    buttonRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        leaveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  useEffect(() => {
    if (mode === 'off') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const root = document.documentElement;
    let leftAt = 0;
    let finishTimer = 0;
    const finish = () => {
      // The page shows through as the overlay fades; the troupe takes the dot.
      root.setAttribute(CRT_INTRO_ATTR, 'done');
      setLeaving(true);
      finishTimer = window.setTimeout(() => setMode('off'), FADE_MS);
    };
    if (mode === 'plain') {
      leaveRef.current = () => {
        if (leftAt) return;
        leftAt = performance.now();
        finish();
      };
      return () => clearTimeout(finishTimer);
    }

    const canvas = canvasRef.current;
    const gl = canvas?.getContext('webgl', { antialias: false, alpha: false });
    if (!canvas || !gl) {
      setMode('plain');
      return;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      setMode('plain');
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setMode('plain');
      return;
    }
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uRes = uniform('uRes');
    const uTime = uniform('uTime');
    const uPower = uniform('uPower');
    const uMotion = uniform('uMotion');
    const uDpr = uniform('uDpr');
    gl.uniform1f(uMotion, reduced ? 0 : 1);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const text = document.createElement('canvas');
    const ctx = text.getContext('2d');
    if (!ctx) {
      setMode('plain');
      return;
    }
    const family = `${getComputedStyle(document.body).getPropertyValue('--font-mono-label').trim() || 'monospace'}, ui-monospace, monospace`;
    const lines = script(window.matchMedia('(hover: none)').matches);

    let dpr = 1;
    let fontPx = 18;
    let charW = 10;
    let lineH = 28;
    let originX = 0;
    let originY = 0;
    let typed = layout(lines, 60, reduced);
    let drawnKey = '';

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = text.width = Math.round(w * dpr);
      canvas.height = text.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uDpr, dpr);
      fontPx = Math.max(15, Math.min(28, w * 0.021));
      ctx.font = `500 ${fontPx}px ${family}`;
      charW = ctx.measureText('M').width;
      lineH = fontPx * 1.6;
      const margin = Math.max(28, w * 0.08);
      const cols = Math.max(18, Math.min(64, Math.floor((w - margin * 2) / charW)));
      // Keep each glyph's timing across resizes: only positions change.
      const fresh = layout(lines, cols, reduced);
      typed = {
        ...fresh,
        glyphs: fresh.glyphs.map((g, i) => ({ ...g, at: typed.glyphs[i]?.at ?? g.at })),
        done: typed.done || fresh.done,
      };
      const blockW = cols * charW;
      originX = Math.max(margin, (w - blockW) / 2);
      originY = Math.max(margin, (h - typed.rows * lineH) / 2);
      drawnKey = '';
    };

    const drawText = (elapsed: number) => {
      let shown = 0;
      while (shown < typed.glyphs.length && typed.glyphs[shown].at <= elapsed) shown++;
      const finished = shown === typed.glyphs.length;
      // Solid while typing; blinks once the prompt is waiting.
      const caretOn = !finished || reduced || Math.floor((elapsed - typed.done) / 0.53) % 2 === 0;
      const key = `${shown}:${caretOn}`;
      if (key === drawnKey) return false;
      drawnKey = key;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, text.width, text.height);
      ctx.font = `500 ${fontPx}px ${family}`;
      ctx.textBaseline = 'top';
      for (let i = 0; i < shown; i++) {
        const g = typed.glyphs[i];
        ctx.fillStyle = g.color;
        ctx.fillText(g.ch, originX + g.col * charW, originY + g.row * lineH);
      }
      if (caretOn) {
        const last = typed.glyphs[shown - 1];
        const col = last ? last.col + 1 : 0;
        const row = last ? last.row : 0;
        ctx.fillStyle = AMBER;
        ctx.fillRect(
          originX + col * charW + 2,
          originY + row * lineH - fontPx * 0.12,
          charW * 0.92,
          fontPx * 1.3
        );
      }
      return true;
    };

    let raf = 0;
    let start = 0;
    let disposed = false;
    const frame = (now: number) => {
      if (disposed) return;
      if (!start) start = now;
      const elapsed = (now - start) / 1000;
      let power = reduced ? 1 : Math.min(1, (now - start) / POWER_ON_MS);
      if (leftAt) {
        const t = Math.min(1, (now - leftAt) / (reduced ? 1 : POWER_OFF_MS));
        // Ease in: the picture holds, then snaps down to the dot.
        power = Math.max(0.03, 1 - t * t);
      }
      if (drawText(elapsed)) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, text);
      }
      gl.uniform1f(uTime, elapsed);
      gl.uniform1f(uPower, power);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(frame);
    };

    leaveRef.current = () => {
      if (leftAt) return;
      leftAt = performance.now();
      finishTimer = window.setTimeout(finish, reduced ? 0 : POWER_OFF_MS - 60);
    };

    resize();
    window.addEventListener('resize', resize);
    // Typing starts once the mono face is ready, so glyphs never re-shape.
    document.fonts.load(`500 ${fontPx}px ${family}`).finally(() => {
      resize();
      raf = requestAnimationFrame(frame);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearTimeout(finishTimer);
      window.removeEventListener('resize', resize);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [mode]);

  if (mode === 'off') return null;
  const lines = plainText(script(touch));
  return (
    <div
      className={`${styles.overlay}${leaving ? ` ${styles.leaving}` : ''}`}
      style={{ '--crt-fade': `${FADE_MS}ms` } as CSSProperties}
    >
      {mode === 'gl' && <canvas ref={canvasRef} className={styles.screen} />}
      <div className={mode === 'plain' ? styles.plain : styles.srOnly}>
        {lines.map((line, i) =>
          line ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed script; lines never reorder.
            <p key={i} style={{ animationDelay: `${0.3 + i * 0.25}s` }}>
              {line}
            </p>
          ) : null
        )}
      </div>
      <button
        ref={buttonRef}
        type="button"
        className={styles.enter}
        onClick={() => leaveRef.current()}
      >
        <span className={styles.srOnly}>Enable Multiplayer AI and enter the site</span>
      </button>
    </div>
  );
}
