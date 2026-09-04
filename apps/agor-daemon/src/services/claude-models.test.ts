import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { toModelOptions } from './claude-models.js';

function model(id: string, displayName: string): Anthropic.ModelInfo {
  return { id, display_name: displayName } as Anthropic.ModelInfo;
}

describe('Claude model discovery materialization', () => {
  it('preserves registered standard and 1M Claude Code choices', () => {
    const options = toModelOptions([
      model('claude-opus-4-8', 'Claude Opus 4.8'),
      model('claude-opus-5', 'Claude Opus 5'),
    ]);

    expect(options.map((option) => option.id)).toEqual([
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-5',
      'claude-opus-5[1m]',
    ]);
    expect(options.map((option) => option.displayName)).toEqual([
      'Claude Opus 4.8 · 200k',
      'Claude Opus 4.8 · 1M',
      'Claude Opus 5 · 200k',
      'Claude Opus 5 · 1M',
    ]);
  });

  it('keeps unknown API aliases selectable without inventing a 1M variant', () => {
    expect(toModelOptions([model('claude-new-6', 'Claude New 6')])).toEqual([
      {
        id: 'claude-new-6',
        displayName: 'Claude New 6',
        description: undefined,
        source: 'dynamic',
      },
    ]);
  });

  it('materializes the verified Claude Fable 5.1 alias as native 1M', () => {
    expect(toModelOptions([model('claude-fable-5-1', 'Claude Fable 5.1')])).toEqual([
      {
        id: 'claude-fable-5-1',
        displayName: 'Claude Fable 5.1 · 1M',
        description: 'Most capable model for demanding reasoning and long-horizon agentic work',
        source: 'dynamic',
      },
    ]);
  });
});
