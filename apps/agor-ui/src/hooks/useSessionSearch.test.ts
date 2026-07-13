import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getMatchOffsets,
  isStructuralMutation,
  REBUILD_DEBOUNCE_MS,
  useSessionSearch,
} from './useSessionSearch';

describe('getMatchOffsets', () => {
  it('returns nothing for empty or whitespace-only queries', () => {
    expect(getMatchOffsets('hello world', '')).toEqual([]);
    expect(getMatchOffsets('hello world', '   ')).toEqual([]);
    expect(getMatchOffsets('', 'hello')).toEqual([]);
  });

  it('finds every non-overlapping, case-insensitive match', () => {
    expect(getMatchOffsets('Foo foo FOO', 'foo')).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
  });

  it('treats regex metacharacters in the query literally', () => {
    expect(getMatchOffsets('a.b a.b axb', 'a.b')).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it('reports offsets that slice back to the matched substring', () => {
    const text = 'the quick brown fox';
    const [start, end] = getMatchOffsets(text, 'quick')[0];
    expect(text.slice(start, end)).toBe('quick');
  });
});

// ── isStructuralMutation ─────────────────────────────────────────────────────

function makeRecord(partial: Partial<MutationRecord>): MutationRecord {
  return {
    type: 'childList',
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    attributeName: null,
    ...partial,
  } as unknown as MutationRecord;
}

function blockEl(marker = 'settled'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-conversation-block', marker);
  return el;
}

describe('isStructuralMutation', () => {
  it('re-scans when a conversation block mounts', () => {
    expect(
      isStructuralMutation([makeRecord({ addedNodes: [blockEl()] as unknown as NodeList })])
    ).toBe(true);
  });

  it('re-scans when an added subtree contains a task block boundary', () => {
    const wrapper = document.createElement('div');
    const task = document.createElement('div');
    task.setAttribute('data-task-block', 'task-1');
    wrapper.appendChild(task);
    expect(
      isStructuralMutation([makeRecord({ addedNodes: [wrapper] as unknown as NodeList })])
    ).toBe(true);
  });

  it('re-scans when a conversation block unmounts (typing indicator at stream end)', () => {
    expect(
      isStructuralMutation([makeRecord({ removedNodes: [blockEl()] as unknown as NodeList })])
    ).toBe(true);
  });

  it('ignores text/inline churn inside an existing block', () => {
    const span = document.createElement('span');
    span.textContent = 'streamed word';
    const text = document.createTextNode('more streamed text');
    expect(
      isStructuralMutation([
        makeRecord({ addedNodes: [span, text] as unknown as NodeList }),
        makeRecord({ type: 'characterData' }),
      ])
    ).toBe(false);
  });

  it("re-scans on the block marker's streaming → settled attribute flip", () => {
    expect(
      isStructuralMutation([
        makeRecord({ type: 'attributes', attributeName: 'data-conversation-block' }),
      ])
    ).toBe(true);
  });

  it('ignores attribute mutations other than the block marker', () => {
    expect(isStructuralMutation([makeRecord({ type: 'attributes', attributeName: 'class' })])).toBe(
      false
    );
  });
});

// ── streaming-settle rescan (hook + DOM) ─────────────────────────────────────

class HighlightStub {
  priority = 0;
  // biome-ignore lint/complexity/noUselessConstructor: mirrors the DOM Highlight signature
  constructor(..._ranges: Range[]) {}
}

describe('useSessionSearch streaming-settle rescan', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom ships neither the CSS Custom Highlight API nor CSS.highlights;
    // without them the hook degrades to no-op scanning, so stub the registry.
    (globalThis as { Highlight?: unknown }).Highlight = HighlightStub;
    (globalThis as { CSS?: { highlights?: unknown } }).CSS = {
      ...(globalThis as { CSS?: object }).CSS,
      highlights: new Map(),
    };
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { Highlight?: unknown }).Highlight;
  });

  /** Let the MutationObserver microtask deliver, then run the debounce out. */
  async function flushObserverAndDebounce() {
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(REBUILD_DEBOUNCE_MS + 10);
    });
  }

  it('a query matching only late-streamed text is found when the message settles', async () => {
    const block = document.createElement('div');
    block.setAttribute('data-conversation-block', 'streaming');
    const textNode = document.createTextNode('hello ');
    block.appendChild(textNode);
    container.appendChild(block);

    const ref = { current: container };
    const { result } = renderHook(() => useSessionSearch(ref));

    act(() => {
      result.current.openSearch();
    });
    act(() => {
      result.current.setQuery('needle');
    });
    await flushObserverAndDebounce();
    expect(result.current.totalMatches).toBe(0);

    // The match streams in as character churn inside the existing block —
    // deliberately NOT a re-scan trigger (that's the per-frame cost this
    // hook avoids), so the count must stay stale for now.
    textNode.data = 'hello needle';
    await flushObserverAndDebounce();
    expect(result.current.totalMatches).toBe(0);

    // Stream end: the message settles in place and TaskBlock flips the wrapper
    // marker. That alone — no mounts/unmounts — must make the text findable.
    block.setAttribute('data-conversation-block', 'settled');
    await flushObserverAndDebounce();
    expect(result.current.totalMatches).toBe(1);
  });
});
