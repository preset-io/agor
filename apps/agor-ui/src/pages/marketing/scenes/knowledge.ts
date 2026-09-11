// Scene — "knowledge" (9s, loop-perfect, booth-loop candidate).
// The REAL KnowledgePage.tsx (sidebar tree, search, the real KnowledgeGraph
// force layout) — not a recreation. A pointer types a real query into the
// real search box (a real debounced kb/search fires and results appear),
// then moves into the graph and hovers two real nodes (real mouseover
// dispatch, real highlight). Never opens a document or a search result —
// both call navigate() in the real component, which would unmount this
// whole demo route (see demoKnowledgePageData.ts).
// Tune via /demo/marketing-video?scene=knowledge&play=1

import { clickPulses, type SceneDefinition, Track } from '../timeline';

const DURATION = 9_000;
const QUERY = 'launch';

const setReactInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const getSearchInput = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('[aria-label="Search all Knowledge"]');

const typeQuery = (upTo: number) => {
  const input = getSearchInput();
  if (input) setReactInputValue(input, QUERY.slice(0, upTo));
};

// The real search dropdown closes on any pointerdown outside its container
// (document-level capture-phase listener) — dispatch one on the graph pane.
const closeSearchDropdown = () => {
  document
    .querySelector<HTMLElement>('.react-flow__pane')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
};

const hoverGraphNode = (documentId: string, hovered: boolean) => {
  const node = document.querySelector(`.react-flow__node[data-id="${documentId}"]`);
  node?.dispatchEvent(
    new MouseEvent(hovered ? 'mouseover' : 'mouseout', {
      bubbles: true,
      relatedTarget: document.body,
    })
  );
};

const TYPE_START = 1_400;
const TYPE_END = 2_400;
const typeActions = Array.from({ length: QUERY.length }, (_, index) => {
  const t = TYPE_START + ((TYPE_END - TYPE_START) * (index + 1)) / QUERY.length;
  return { t, run: () => typeQuery(index + 1) };
});

export const knowledgeScene: SceneDefinition = {
  name: 'knowledge',
  durationMs: DURATION,
  viewport: new Track([{ t: 0, v: { x: 109, y: 0, zoom: 0.56 } }]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    knowledgeOpen: new Track([{ t: 0, v: 1 }]),
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 960 },
      { t: 900, v: 700 },
      { t: 1_200, v: 700, easing: 'hold' },
      { t: 3_600, v: 700, easing: 'hold' },
      { t: 4_600, v: 1_200 },
      { t: 5_600, v: 1_200, easing: 'hold' },
      { t: 6_600, v: 1_450 },
      { t: 7_600, v: 1_450, easing: 'hold' },
    ]),
    pointerY: new Track([
      { t: 0, v: 700 },
      { t: 900, v: 130 },
      { t: 1_200, v: 130, easing: 'hold' },
      { t: 3_600, v: 130, easing: 'hold' },
      { t: 4_600, v: 500 },
      { t: 5_600, v: 500, easing: 'hold' },
      { t: 6_600, v: 620 },
      { t: 7_600, v: 620, easing: 'hold' },
    ]),
    pointerRipple: clickPulses([1_250]),
  },
  actions: [
    ...typeActions,
    { t: 4_100, run: closeSearchDropdown },
    { t: 4_700, run: () => hoverGraphNode('demo-doc-launch-plan', true) },
    { t: 5_500, run: () => hoverGraphNode('demo-doc-launch-plan', false) },
    { t: 6_700, run: () => hoverGraphNode('demo-doc-gtm-messaging', true) },
    { t: 7_500, run: () => hoverGraphNode('demo-doc-gtm-messaging', false) },
  ],
};
