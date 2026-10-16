import { describe, expect, it } from 'vitest';
import { closeOtherSessionTabs, closeSessionTab, openSessionTab } from './useSessionTabs';

const tabs = (ids: string[], selectedId: string | null = ids[0] ?? null) => ({ ids, selectedId });

describe('session tab state', () => {
  it('appends a newly opened session and selects it', () => {
    expect(openSessionTab(tabs(['a']), 'b')).toEqual(tabs(['a', 'b'], 'b'));
  });

  it('selects an already open session without duplicating or reordering it', () => {
    expect(openSessionTab(tabs(['a', 'b', 'c'], 'c'), 'a')).toEqual(tabs(['a', 'b', 'c'], 'a'));
  });

  it('selects the right neighbour when the selected tab closes, else the left one', () => {
    expect(closeSessionTab(tabs(['a', 'b', 'c'], 'b'), 'b')).toEqual(tabs(['a', 'c'], 'c'));
    expect(closeSessionTab(tabs(['a', 'b', 'c'], 'c'), 'c')).toEqual(tabs(['a', 'b'], 'b'));
  });

  it('keeps the selection when another tab closes', () => {
    expect(closeSessionTab(tabs(['a', 'b', 'c'], 'a'), 'c')).toEqual(tabs(['a', 'b'], 'a'));
  });

  it('closes the panel with the last tab', () => {
    expect(closeSessionTab(tabs(['a']), 'a')).toEqual(tabs([], null));
  });

  it('keeps only the chosen tab on close other tabs', () => {
    expect(closeOtherSessionTabs(tabs(['a', 'b', 'c'], 'a'), 'b')).toEqual(tabs(['b'], 'b'));
  });
});
