// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Demo-video staging route (/demo/marketing-video?scene=multiplayer|artifact|settings).
// Fork of MarketingScreenshotPage where ALL motion — cursors, card drags,
// typed text, viewport, overlays — is a pure function of a virtual clock `t`.
// The Playwright pipeline in apps/agor-docs/demo-videos steps `t` frame by
// frame via window.__agorDemo and screenshots each frame; ?play=1 runs the
// same timeline on the wall clock for humans iterating on choreography.
// The static screenshot route is untouched and shares fixtures via ./fixtureData.

import { App as AntdApp, ConfigProvider, Layout, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider, useReactFlow, useViewport } from 'reactflow';
import { AppHeader } from '../../components/AppHeader';
import { SessionCanvas } from '../../components/SessionCanvas';
import type { StaticRemoteCursor } from '../../components/SessionCanvas/canvas/RemoteCursorLayer';
import { SessionSettingsModal } from '../../components/SessionSettingsModal';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { DemoSessionStage, type StageVariant } from './DemoSessionStage';
import { DemoSlackStage } from './DemoSlackStage';
import {
  buildDemoStoreMaps,
  demoActiveUsers,
  demoBoard,
  demoBoardId,
  demoBranches,
  demoSessions,
  demoUsers,
} from './fixtureData';
import { artifactScene } from './scenes/artifact';
import { boardsScene } from './scenes/boards';
import { GATEWAY_PROMPT, gatewayScene } from './scenes/gateway';
import { multiplayerScene } from './scenes/multiplayer';
import { sessionScene } from './scenes/session';
import { sessionsLoopScene } from './scenes/sessionsLoop';
import { settingsScene } from './scenes/settings';
import { ActionRunner, type SceneDefinition, type Track } from './timeline';
import './MarketingVideoPage.css';

const SCENES: Record<string, SceneDefinition> = {
  multiplayer: multiplayerScene,
  session: sessionScene,
  artifact: artifactScene,
  settings: settingsScene,
  // Showcase-carousel cuts (apps/agor-docs "So much more than a chat box").
  boards: boardsScene,
  sessions: sessionsLoopScene,
  gateway: gatewayScene,
};

// Which DemoSessionStage story each scene tells (default: 'coding').
const STAGE_VARIANT_BY_SCENE: Record<string, StageVariant> = {
  gateway: 'gateway',
  multiplayer: 'collab',
};

declare global {
  interface Window {
    __agorDemo?: {
      scene: string;
      getDuration: () => number;
      setTime: (ms: number) => void;
      isReady: () => boolean;
    };
  }
}

const sampleFlag = (
  uiFlags: SceneDefinition['uiFlags'],
  key: string,
  t: number,
  fallback = 0
): number => {
  const track: Track<number> | undefined = uiFlags[key];
  return track ? track.sample(t) : fallback;
};

/** Applies the scene's viewport track every frame (and stomps SessionCanvas's
 * one-time mount fitView with a few delayed re-applies). */
const DemoViewportDirector = ({ scene, t }: { scene: SceneDefinition; t: number }) => {
  const { setViewport } = useReactFlow();

  useEffect(() => {
    setViewport(scene.viewport.sample(t), { duration: 0 });
  }, [scene, t, setViewport]);

  useEffect(() => {
    const timers = [300, 700, 1_200].map((delay) =>
      window.setTimeout(() => setViewport(scene.viewport.sample(0), { duration: 0 }), delay)
    );
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [scene, setViewport]);

  return null;
};

/** Scene 2: cover panel over the cost-cockpit app node that "generates" and
 * then wipes away to reveal the live Sandpack chart beneath. Projected from
 * flow coordinates so it stays glued to the node through viewport moves. */
const ArtifactRevealOverlay = ({ scene, t }: { scene: SceneDefinition; t: number }) => {
  const viewport = useViewport();
  const appObject = demoBoard.objects?.['app-usage-cockpit'] as
    | { x: number; y: number; width?: number; height?: number }
    | undefined;
  if (!appObject || !scene.uiFlags.overlayReveal) return null;

  const reveal = sampleFlag(scene.uiFlags, 'overlayReveal', t);
  const badgePhase = sampleFlag(scene.uiFlags, 'badgePhase', t);
  const shimmer = sampleFlag(scene.uiFlags, 'shimmer', t) % 1;
  const success = sampleFlag(scene.uiFlags, 'successPulse', t);

  const left = appObject.x * viewport.zoom + viewport.x;
  const top = appObject.y * viewport.zoom + viewport.y;
  const width = (appObject.width ?? 780) * viewport.zoom;
  const height = (appObject.height ?? 495) * viewport.zoom;

  return (
    <>
      {reveal < 1 && (
        <div
          className="marketing-video-artifact-cover"
          style={{
            left,
            top,
            width,
            height,
            clipPath: `inset(${reveal * 100}% 0 0 0)`,
          }}
        >
          <div
            className="shimmer"
            style={{ transform: `translateX(${(shimmer * 2 - 1) * 100}%)` }}
          />
          <div className="marketing-video-artifact-badge">
            <span className="dot" />
            {badgePhase < 0.5 ? 'Generating artifact…' : 'Rendering…'}
          </div>
        </div>
      )}
      {success > 0 && success <= 1 && (
        <div
          className="marketing-video-success-ring"
          style={{
            left: left - success * 10,
            top: top - success * 10,
            width: width + success * 20,
            height: height + success * 20,
            opacity: 1 - success,
          }}
        />
      )}
    </>
  );
};

/** Screen-space demo pointer for scenes that interact with portaled UI
 * (modals render above the flow-space cursor layer). */
const DemoScreenPointer = ({ scene, t }: { scene: SceneDefinition; t: number }) => {
  if (!scene.uiFlags.pointerX) return null;
  const visible = sampleFlag(scene.uiFlags, 'pointerVisible', t, 1);
  if (visible < 0.5) return null;
  const x = sampleFlag(scene.uiFlags, 'pointerX', t);
  const y = sampleFlag(scene.uiFlags, 'pointerY', t);
  const ripple = sampleFlag(scene.uiFlags, 'pointerRipple', t);
  const size = 8 + ripple * 36;

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        transform: `translate3d(${x}px, ${y}px, 0) scale(1.3)`,
        transformOrigin: 'top left',
        zIndex: 99_999,
        pointerEvents: 'none',
      }}
    >
      {ripple > 0 && ripple <= 1 && (
        <span
          style={{
            position: 'absolute',
            top: 4,
            left: 6,
            width: size,
            height: size,
            marginLeft: -size / 2,
            marginTop: -size / 2,
            borderRadius: '50%',
            border: '2px solid #14b8a6',
            opacity: 1 - ripple,
          }}
        />
      )}
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5.5 3.5L18.5 12L11 14L8 20.5L5.5 3.5Z"
          fill="#14b8a6"
          stroke="#0b1220"
          strokeWidth="1.5"
          strokeLinejoin="round"
          style={{ filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4))' }}
        />
      </svg>
    </div>
  );
};

/** Labeled teammate cursors in SCREEN space (page px) — for scenes where
 * named users interact with UI above the canvas (the staged session panel,
 * the Slack stage). Mirrors RemoteCursorLayer's cursor + name-chip styling. */
const DemoScreenCursors = ({ scene, t }: { scene: SceneDefinition; t: number }) => {
  if (!scene.screenCursors || scene.screenCursors.length === 0) return null;
  return (
    <>
      {scene.screenCursors.map((cursor) => {
        const user = cursor.user ?? demoUsers[cursor.userIndex];
        const position = cursor.pos.sample(t);
        const ripple = cursor.ripple?.sample(t) ?? 0;
        const rippleSize = 8 + ripple * 36;
        return (
          <div
            key={user.user_id}
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(1.3)`,
              transformOrigin: 'top left',
              zIndex: 99_998,
              pointerEvents: 'none',
            }}
          >
            <div style={{ position: 'relative', width: 24, height: 24 }}>
              {ripple > 0 && ripple <= 1 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 4,
                    left: 6,
                    width: rippleSize,
                    height: rippleSize,
                    marginLeft: -rippleSize / 2,
                    marginTop: -rippleSize / 2,
                    borderRadius: '50%',
                    border: `2px solid ${cursor.color}`,
                    opacity: 1 - ripple,
                  }}
                />
              )}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M5.5 3.5L18.5 12L11 14L8 20.5L5.5 3.5Z"
                  fill={cursor.color}
                  stroke="#1f1f1f"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  style={{ filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4))' }}
                />
              </svg>
              <div
                style={{
                  position: 'absolute',
                  top: 24,
                  left: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  background: cursor.color,
                  color: '#ffffff',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
                }}
              >
                <span style={{ fontSize: 14 }}>{user.emoji}</span>
                <span style={{ fontWeight: 500 }}>{user.name || user.email}</span>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
};

/** Full-frame loop-closure veil: fades the ENTIRE page to its background
 * color while scene state (transcript, comments, cursors) resets to the
 * establish beat, then lifts — the whole-composition analog of
 * DemoSessionStage's panel-scoped resetVeil. */
const DemoGlobalVeil = ({ scene, t }: { scene: SceneDefinition; t: number }) => {
  if (!scene.uiFlags.globalVeil) return null;
  const veil = sampleFlag(scene.uiFlags, 'globalVeil', t);
  if (veil <= 0) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100_000,
        background: '#07111d',
        opacity: veil,
        pointerEvents: 'none',
      }}
    />
  );
};

// Session shown in the settings scene: landing-hero-polish's claude-code session.
const settingsSession = demoSessions.find(
  (session) => session.session_id === '019ee88d-demo-branch-0000-000000000101-session-1'
);

export const MarketingVideoPage = () => {
  const params = new URLSearchParams(window.location.search);
  const sceneName = params.get('scene') ?? 'multiplayer';
  const play = params.get('play') === '1';
  const scene = SCENES[sceneName] ?? multiplayerScene;

  const [t, setT] = useState(0);
  const readyRef = useRef(false);
  const runnerRef = useRef<ActionRunner | null>(null);
  if (runnerRef.current === null) {
    runnerRef.current = new ActionRunner(scene.actions);
  }

  const baseMaps = useMemo(() => buildDemoStoreMaps(), []);

  useEffect(() => {
    document.title = `Demo video · ${scene.name} · Agor`;
  }, [scene]);

  // Seed the global store exactly like the static screenshot route does —
  // SessionCanvas reads entities via store selectors, not props.
  useEffect(() => {
    agorStore.setState({
      boardById: baseMaps.boardById,
      repoById: baseMaps.repoById,
      branchById: baseMaps.branchById,
      sessionById: baseMaps.sessionById,
      sessionsByBranch: baseMaps.sessionsByBranch,
      boardObjectById: baseMaps.boardObjectById,
      boardObjectsByBoardId: baseMaps.boardObjectsByBoardId,
      cardById: baseMaps.cardById,
      userById: baseMaps.userById,
      commentById: baseMaps.commentById,
      artifactById: new Map(),
      mcpServerById: new Map(),
    });
    let raf = 0;
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        readyRef.current = true;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [baseMaps]);

  // Re-seed the animated slices of the store for the current `t`. New Map /
  // array / object identities for animated entries only, so SessionCanvas's
  // selector subscriptions and node-sync effects fire.
  useEffect(() => {
    if (scene.nodePlacements.length > 0) {
      const bucket = baseMaps.boardObjectsByBoardId.get(demoBoardId) ?? [];
      const patched = bucket.map((object) => {
        const placement = scene.nodePlacements.find((p) => p.objectId === object.object_id);
        if (!placement) return object;
        const position = placement.pos.sample(t);
        const zoneId = placement.zoneId.sample(t);
        return {
          ...object,
          position: { x: position.x, y: position.y },
          zone_id: zoneId ?? undefined,
        };
      });
      const boardObjectById = new Map(baseMaps.boardObjectById);
      for (const object of patched) {
        boardObjectById.set(object.object_id, object);
      }
      agorStore.setState({
        boardObjectsByBoardId: new Map([[demoBoardId, patched]]),
        boardObjectById,
      });
    }
    if (scene.commentTexts.length > 0) {
      const commentById = new Map(baseMaps.commentById);
      for (const commentTimeline of scene.commentTexts) {
        const comment = commentById.get(commentTimeline.commentId);
        if (comment) {
          const content = commentTimeline.text.sample(t);
          commentById.set(commentTimeline.commentId, {
            ...comment,
            content,
            content_preview: content,
          });
        }
      }
      agorStore.setState({ commentById });
    }
    runnerRef.current?.advanceTo(t);
  }, [t, scene, baseMaps]);

  // Frame-stepping driver for the Playwright capture pipeline.
  useEffect(() => {
    window.__agorDemo = {
      scene: scene.name,
      getDuration: () => scene.durationMs,
      setTime: (ms: number) => setT(ms),
      isReady: () => readyRef.current,
    };
    return () => {
      delete window.__agorDemo;
    };
  }, [scene]);

  // ?play=1 — wall-clock preview loop for choreography iteration. Action
  // keyframes re-fire each cycle but DOM side effects (e.g. an opened
  // dropdown) do not rewind; reload for a clean pass.
  useEffect(() => {
    if (!play) return;
    let raf = 0;
    let cycleStart = performance.now();
    const loop = (nowMs: number) => {
      if (nowMs - cycleStart >= scene.durationMs) {
        cycleStart = nowMs;
        runnerRef.current?.reset();
      }
      setT(nowMs - cycleStart);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [play, scene]);

  const cursors: StaticRemoteCursor[] = scene.cursors.map((cursor) => {
    const user = cursor.user ?? demoUsers[cursor.userIndex];
    const position = cursor.pos.sample(t);
    return {
      userId: user.user_id,
      user,
      color: cursor.color,
      x: position.x,
      y: position.y,
      ripple: cursor.ripple?.sample(t) ?? 0,
    };
  });

  const settingsOpen = sampleFlag(scene.uiFlags, 'settingsOpen', t) > 0.5;

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#14b8a6',
          borderRadius: 12,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          // All visible motion must come from the timeline: kill antd's
          // wall-clock transitions so captured frames are deterministic.
          motion: false,
        },
      }}
    >
      <AntdApp>
        <ConnectionProvider
          value={{
            connected: true,
            connecting: false,
            outOfSync: false,
            capturedSha: null,
            currentSha: null,
          }}
        >
          <Layout className="marketing-video-page" data-testid="marketing-video-page">
            <AppHeader
              user={demoUsers[0]}
              presenceClient={null}
              currentUserId={demoUsers[0].user_id}
              staticActiveUsers={demoActiveUsers}
              connected={true}
              connecting={false}
              currentBoardName={demoBoard.name}
              currentBoardIcon={demoBoard.icon}
              unreadCommentsCount={1}
              eventStreamEnabled={true}
              hasUserMentions={true}
              currentBoardId={demoBoardId}
            />
            <main className="marketing-video-canvas">
              <ReactFlowProvider>
                <DemoViewportDirector scene={scene} t={t} />
                <SessionCanvas
                  board={demoBoard}
                  client={null}
                  branches={demoBranches}
                  currentUserId={demoUsers[0].user_id}
                  selectedSessionId={null}
                  availableAgents={[]}
                  staticCursors={cursors}
                  staticCursorScale={1.3}
                  height="calc(100vh - 64px)"
                />
                <ArtifactRevealOverlay scene={scene} t={t} />
              </ReactFlowProvider>
              {/* Scenes "session"/"sessions"/"gateway"/"multiplayer": staged panel on the right */}
              {scene.uiFlags.sessionPhase && (
                <DemoSessionStage
                  scene={scene}
                  t={t}
                  variant={STAGE_VARIANT_BY_SCENE[scene.name] ?? 'coding'}
                />
              )}
              {/* Scene "gateway": Slack-style channel stage on the left */}
              {scene.uiFlags.slackPhase && (
                <DemoSlackStage scene={scene} t={t} prompt={GATEWAY_PROMPT} />
              )}
            </main>
            {settingsSession && scene.uiFlags.settingsOpen && (
              <SessionSettingsModal
                open={settingsOpen}
                onClose={() => undefined}
                session={settingsSession}
                client={null}
                currentUser={demoUsers[0]}
              />
            )}
            <DemoScreenPointer scene={scene} t={t} />
            <DemoScreenCursors scene={scene} t={t} />
            <DemoGlobalVeil scene={scene} t={t} />
          </Layout>
        </ConnectionProvider>
      </AntdApp>
    </ConfigProvider>
  );
};

export default MarketingVideoPage;
