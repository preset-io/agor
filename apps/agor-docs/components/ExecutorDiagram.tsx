// Hand-authored SVG for the daemon↔executor flow. Built by hand (not mermaid)
// because the routing is deliberate: the edges sweep around the perimeter to
// form a loop — down the left (daemon → spawn → local → executor), straight
// down the center, and back up the right (executor → WebSocket → daemon) —
// which mermaid's auto-layout can't express.

const LINE = '#aeb8b5';
const CODE = '#7fe8df';
const MUTED = '#9fb4ae';
const INK = '#eafff9';

// Corner radius shared by every bend, so all four loop corners match.
// 0 = sharp rectangle · large = more circular.
const R = 26;

// Orthogonal path through waypoints with a uniform rounded corner at each
// interior point (quadratic bend of radius R). Keeps every corner identical.
function roundPath(pts: Array<[number, number]>): string {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const ri = Math.min(R, inLen / 2);
    const ro = Math.min(R, outLen / 2);
    const ex = cx - ((cx - px) / inLen) * ri;
    const ey = cy - ((cy - py) / inLen) * ri;
    const xx = cx + ((nx - cx) / outLen) * ro;
    const xy = cy + ((ny - cy) / outLen) * ro;
    d += ` L${ex.toFixed(1)},${ey.toFixed(1)} Q${cx},${cy} ${xx.toFixed(1)},${xy.toFixed(1)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` L${lx},${ly}`;
  return d;
}

// Reusable box (rounded rect + centered multi-line text).
function Box({
  x,
  y,
  w,
  h,
  stroke = 'rgba(255,255,255,0.14)',
  fill = '#10201d',
  children,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  stroke?: string;
  fill?: string;
  children: React.ReactNode;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill={fill}
        stroke={stroke}
        strokeWidth={1.5}
      />
      {children}
    </g>
  );
}

export function ExecutorDiagram() {
  return (
    <svg
      viewBox="0 0 780 620"
      role="img"
      aria-label="Daemon spawns executors locally or in containers over stdin; executors connect back over WebSocket"
      style={{ width: '100%', height: 'auto', margin: '1.5rem 0', maxWidth: 780 }}
      fontFamily="var(--font-body-stack, system-ui, sans-serif)"
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={LINE} />
        </marker>
      </defs>

      {/* ---- Connectors (drawn first, behind the boxes). The spawn/WebSocket
             pills are labels that sit ON these lines — each edge is one
             continuous line with a single arrowhead at its destination NODE,
             so no pill has an inbound arrow. Every corner shares radius R. ---- */}
      <g fill="none" stroke={LINE} strokeWidth={1.6}>
        {/* Left branch: Daemon.left → Local.top (left spawn pill sits on it) */}
        <path
          d={roundPath([
            [283, 74],
            [120, 74],
            [120, 262],
          ])}
          markerEnd="url(#arrow)"
        />
        {/* Local.bottom → Executor.left */}
        <path
          d={roundPath([
            [120, 360],
            [120, 499],
            [292, 499],
          ])}
          markerEnd="url(#arrow)"
        />

        {/* Center branch: Daemon.bottom → Containerized.top (spawn pill on it) */}
        <path d="M410,126 L410,262" markerEnd="url(#arrow)" />
        {/* Containerized.bottom → Executor.top */}
        <path d="M411,360 L411,396" markerEnd="url(#arrow)" />

        {/* Right branch (return): Executor.right → Daemon.right (WebSocket pill
            sits on it) */}
        <path
          d={roundPath([
            [526, 499],
            [665, 499],
            [665, 74],
            [539, 74],
          ])}
          markerEnd="url(#arrow)"
        />
      </g>

      {/* ---- Boxes ---- */}
      {/* Daemon */}
      <Box x={283} y={22} w={256} h={104} stroke="#34e6c4">
        <text textAnchor="middle" fill={INK}>
          <tspan x={411} y={52} fontWeight="700">
            Daemon — orchestration
          </tspan>
          <tspan x={411} y={77} fill={MUTED} fontSize={13}>
            REST + WebSocket API (FeathersJS)
          </tspan>
          <tspan x={411} y={97} fill={MUTED} fontSize={13}>
            database · auth · executor tokens
          </tspan>
        </text>
      </Box>

      {/* Spawn label pills */}
      <Box x={25} y={170} w={190} h={52} fill="#1c2926" stroke="rgba(255,255,255,0.1)">
        <text textAnchor="middle" fill={MUTED} fontSize={13}>
          <tspan x={120} y={192}>
            spawn · typed JSON
          </tspan>
          <tspan x={120} y={210}>
            via stdin
          </tspan>
        </text>
      </Box>
      <Box x={315} y={170} w={190} h={52} fill="#1c2926" stroke="rgba(255,255,255,0.1)">
        <text textAnchor="middle" fill={MUTED} fontSize={13}>
          <tspan x={410} y={192}>
            spawn · typed JSON
          </tspan>
          <tspan x={410} y={210}>
            via stdin
          </tspan>
        </text>
      </Box>

      {/* Local */}
      <Box x={18} y={262} w={204} h={98}>
        <text textAnchor="middle">
          <tspan x={120} y={294} fill={INK} fontWeight="700">
            Local
          </tspan>
          <tspan fill={MUTED} fontWeight="400">
            {' '}
            (default)
          </tspan>
          <tspan
            x={120}
            y={324}
            fill={CODE}
            fontSize={13}
            fontFamily="var(--font-mono-stack, monospace)"
          >
            node executor --stdin
          </tspan>
        </text>
      </Box>

      {/* Containerized */}
      <Box x={288} y={262} w={244} h={98}>
        <text textAnchor="middle">
          <tspan x={410} y={292} fill={INK} fontWeight="700">
            Containerized
          </tspan>
          <tspan
            x={410}
            y={318}
            fill={CODE}
            fontSize={12.5}
            fontFamily="var(--font-mono-stack, monospace)"
          >
            executor_command_template
          </tspan>
          <tspan
            x={410}
            y={338}
            fill={CODE}
            fontSize={12.5}
            fontFamily="var(--font-mono-stack, monospace)"
          >
            via sh -c
          </tspan>
        </text>
      </Box>

      {/* Executor */}
      <Box x={296} y={398} w={230} h={202} stroke="#e8c468">
        <text textAnchor="middle">
          <tspan x={411} y={430} fill={INK} fontWeight="700">
            Executor — isolation
          </tspan>
          <tspan x={411} y={450} fill={INK} fontWeight="700">
            boundary
          </tspan>
          <tspan fill={MUTED} fontWeight="400">
            {' '}
            (ephemeral)
          </tspan>
          <tspan x={411} y={484} fill={INK} fontSize={13} fontWeight="700">
            Harnesses
          </tspan>
          <tspan x={411} y={503} fill={MUTED} fontSize={12.5}>
            Claude Code · Codex · Gemini
          </tspan>
          <tspan x={411} y={521} fill={MUTED} fontSize={12.5}>
            OpenCode · Copilot · Cursor
          </tspan>
          <tspan x={411} y={550} fill={INK} fontSize={13} fontWeight="700">
            Git
          </tspan>
          <tspan fill={MUTED} fontSize={12.5} fontWeight="400">
            {' '}
            clone · branch
          </tspan>
          <tspan x={411} y={575} fill={INK} fontSize={13} fontWeight="700">
            Terminals
          </tspan>
          <tspan fill={MUTED} fontSize={12.5} fontWeight="400">
            {' '}
            Zellij + node-pty
          </tspan>
        </text>
      </Box>

      {/* WebSocket return label */}
      <Box x={575} y={272} w={180} h={54} fill="#1c2926" stroke="rgba(255,255,255,0.1)">
        <text textAnchor="middle" fill={MUTED} fontSize={13}>
          <tspan x={665} y={295}>
            results + events
          </tspan>
          <tspan x={665} y={313}>
            via WebSocket
          </tspan>
        </text>
      </Box>
    </svg>
  );
}
