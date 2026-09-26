/**
 * The mint seam's two gates.
 *
 * `authorizeWidgetMint` and `parseWidgetMintParams` are separate calls because
 * they answer separate questions and one of them also runs early, with no
 * params. Both fail closed on an unregistered type, because a widget whose
 * entry is missing is a widget whose gate is missing.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  _resetWidgetRegistryForTests,
  authorizeWidgetMint,
  parseWidgetMintParams,
  registerWidget,
} from './registry.js';

const strictEntry = {
  type: 'strict_test' as const,
  schemaVersion: 1,
  paramsSchema: z.object({ name: z.string().min(1) }).strict(),
  submitSchema: z.object({}),
  buildResultMeta: () => ({}),
  applySubmit: async () => {},
  buildAutoResumePrompt: () => '',
  buildDismissedPrompt: () => '',
};

const lenientEntry = {
  ...strictEntry,
  type: 'lenient_test' as const,
  paramsSchema: z.object({ name: z.string().min(1), flag: z.boolean().default(true) }),
};

describe('parseWidgetMintParams', () => {
  it('enforces the registered schema and returns what it accepted', () => {
    _resetWidgetRegistryForTests();
    try {
      registerWidget(strictEntry);
      registerWidget(lenientEntry);

      expect(parseWidgetMintParams('strict_test', { name: 'ok' })).toEqual({ name: 'ok' });
      // `.strict()` refuses. A caller building params with `satisfies` gets a
      // compile-time check that strips nothing at runtime, which is exactly
      // the gap this closes.
      expect(() => parseWidgetMintParams('strict_test', { name: 'ok', extra: 1 })).toThrow();
      expect(() => parseWidgetMintParams('strict_test', { name: '' })).toThrow();

      // A plain object schema strips instead of refusing, and applies its
      // defaults. The row records whichever the type asked for, which is why
      // the parsed value is returned rather than discarded.
      expect(parseWidgetMintParams('lenient_test', { name: 'ok', extra: 1 })).toEqual({
        name: 'ok',
        flag: true,
      });
    } finally {
      _resetWidgetRegistryForTests();
    }
  });

  it('refuses an unregistered type rather than passing it through', async () => {
    _resetWidgetRegistryForTests();
    expect(() => parseWidgetMintParams('never_registered', {})).toThrow(
      /not registered on this daemon/i
    );
    await expect(authorizeWidgetMint('never_registered', {} as never, {})).rejects.toThrow(
      /not registered on this daemon/i
    );
  });
});
