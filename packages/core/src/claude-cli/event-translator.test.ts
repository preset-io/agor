import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlEventTranslator } from './event-translator.js';

describe('JsonlEventTranslator', () => {
  it('emits turn_start on queue-operation enqueue', () => {
    const t = new JsonlEventTranslator();
    expect(
      t.translateLine(
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          timestamp: '2026-05-14T00:00:00Z',
        })
      )
    ).toEqual([{ type: 'turn_start', timestamp: '2026-05-14T00:00:00Z' }]);
  });

  it('ignores queue-operation dequeue', () => {
    const t = new JsonlEventTranslator();
    expect(
      t.translateLine(JSON.stringify({ type: 'queue-operation', operation: 'dequeue' }))
    ).toEqual([]);
  });

  it('dedups assistant turns by message.id (cumulative-snapshot footgun)', () => {
    const t = new JsonlEventTranslator();
    const sharedMsg = {
      id: 'msg_01ULxJHPur6nS1o2wuLaG4ri',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input_tokens: 100, output_tokens: 200 },
      stop_reason: 'tool_use',
    };
    // Simulate the live behavior: same `message.id` shows up 5x in the
    // JSONL, each with cumulative usage.
    const lines = [
      { type: 'assistant', uuid: 'a', timestamp: 't1', message: sharedMsg },
      { type: 'assistant', uuid: 'b', timestamp: 't2', message: sharedMsg },
      { type: 'assistant', uuid: 'c', timestamp: 't3', message: sharedMsg },
    ];
    const events = lines.flatMap((l) =>
      t.translateParsed(l as Parameters<typeof t.translateParsed>[0])
    );
    const assistantEvents = events.filter((e) => e.type === 'assistant_message');
    expect(assistantEvents).toHaveLength(1);
    expect(t.getSeenMessageIds().size).toBe(1);
  });

  it('emits turn_end on any terminal stop_reason except tool_use', () => {
    const t = new JsonlEventTranslator();
    const baseMsg = {
      id: 'msg_endturn',
      role: 'assistant',
      content: [],
      usage: {},
    };
    // First line: tool_use → no turn_end (turn still open)
    const e1 = t.translateParsed({
      type: 'assistant',
      uuid: 'a',
      message: { ...baseMsg, stop_reason: 'tool_use' },
    } as Parameters<typeof t.translateParsed>[0]);
    expect(e1.find((e) => e.type === 'turn_end')).toBeUndefined();
    // Second line: end_turn → turn_end emitted (dedup'd as assistant_message
    // but turn_end still fires)
    const e2 = t.translateParsed({
      type: 'assistant',
      uuid: 'b',
      timestamp: 't2',
      message: { ...baseMsg, stop_reason: 'end_turn' },
    } as Parameters<typeof t.translateParsed>[0]);
    const endEvent = e2.find((e) => e.type === 'turn_end');
    expect(endEvent).toEqual({ type: 'turn_end', messageId: 'msg_endturn', timestamp: 't2' });
  });

  it('emits turn_end on max_tokens / stop_sequence / refusal', () => {
    // Each terminal stop_reason should close the turn so the task gets
    // patched COMPLETED and the session returns to IDLE. Without this,
    // a max-token cutoff would strand the task RUNNING forever.
    for (const stop of ['max_tokens', 'stop_sequence', 'refusal'] as const) {
      const t = new JsonlEventTranslator();
      const events = t.translateParsed({
        type: 'assistant',
        uuid: 'a',
        timestamp: 'ts',
        message: {
          id: `msg_${stop}`,
          role: 'assistant',
          content: [],
          usage: {},
          stop_reason: stop,
        },
      } as Parameters<typeof t.translateParsed>[0]);
      const endEvent = events.find((e) => e.type === 'turn_end');
      expect(endEvent, `expected turn_end for stop_reason=${stop}`).toBeDefined();
    }
  });

  it('routes user lines with toolUseResult to tool_result events', () => {
    const t = new JsonlEventTranslator();
    const events = t.translateLine(
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: 't1',
        sourceToolAssistantUUID: 'tool_abc',
        toolUseResult: { stdout: 'hi' },
        message: { role: 'user', content: 'whatever' },
      })
    );
    expect(events).toEqual([
      {
        type: 'tool_result',
        uuid: 'u1',
        timestamp: 't1',
        sourceToolAssistantUUID: 'tool_abc',
        result: { stdout: 'hi' },
        isSidechain: false,
      },
    ]);
  });

  it('routes ai-title to ai_title events', () => {
    const t = new JsonlEventTranslator();
    expect(
      t.translateLine(JSON.stringify({ type: 'ai-title', aiTitle: 'My Session', timestamp: 't' }))
    ).toEqual([{ type: 'ai_title', title: 'My Session' }]);
  });

  it('surfaces unknown event types without crashing', () => {
    const t = new JsonlEventTranslator();
    const events = t.translateLine(JSON.stringify({ type: 'totally_made_up', foo: 'bar' }));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('unknown');
  });

  it('surfaces parse_error for malformed JSON', () => {
    const t = new JsonlEventTranslator();
    const events = t.translateLine('not-json{{{');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'unknown', jsonType: 'parse_error' });
  });
});

describe('JsonlEventTranslator — fixture replay', () => {
  // Replay the live analysis-session JSONL referenced in Appendix A of the
  // design doc. Skipped when the fixture isn't present on this machine
  // (CI / clean checkouts) — kept here so it can run locally during
  // development of the watcher / translator.
  const fixturePath =
    '/home/max/.claude/projects/-var-lib-agor-home-agorpg--agor-worktrees-preset-io-agor-analyze-claude-code-cli-integration/d72a04ab-2f8b-4917-a2ed-fd3d797dab9b.jsonl';

  const present = fs.existsSync(fixturePath);

  it.skipIf(!present)('processes every line and dedups assistant turns', () => {
    const t = new JsonlEventTranslator();
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const allEvents = lines.flatMap((l) => t.translateLine(l));

    // Sanity: every line produced at least one event OR was an explicit
    // duplicate dedup (which returns []).
    expect(allEvents.length).toBeGreaterThan(0);

    // Dedup invariant: number of `assistant_message` events ===
    // number of unique seen message ids.
    const assistantEvents = allEvents.filter((e) => e.type === 'assistant_message');
    expect(assistantEvents.length).toBe(t.getSeenMessageIds().size);

    // Naive line-count vs dedup'd assistant count — the over-count footgun.
    // Verified live: ratio is typically 3-6×. Asserting >1 catches any
    // regression that silently disables dedup.
    const rawAssistantLines = lines.filter((l) => l.includes('"type":"assistant"')).length;
    expect(rawAssistantLines).toBeGreaterThan(assistantEvents.length);

    // No `unknown` events should be `parse_error` — the fixture is
    // line-buffered valid JSON.
    const parseErrors = allEvents.filter(
      (e) => e.type === 'unknown' && e.jsonType === 'parse_error'
    );
    expect(parseErrors).toEqual([]);
  });

  // Print is useful when developing — keep around but commented.
  // it('dump fixture path', () => { console.log(path.resolve(fixturePath)); });
  void path; // appease linter when fixture path is unused
});
