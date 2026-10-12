import { describe, expect, it } from 'vitest';
import { isMissingGeminiSdk } from './tool-registry.js';

function missingModule(message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });
}

describe('Gemini optional-install error classification', () => {
  it('recognizes only a missing top-level Gemini SDK package', () => {
    expect(
      isMissingGeminiSdk(
        missingModule("Cannot find package '@google/gemini-cli-core' imported from /app/gemini.js")
      )
    ).toBe(true);
    expect(
      isMissingGeminiSdk(
        missingModule("Cannot find module '@google/gemini-cli-core' imported from /app/gemini.js")
      )
    ).toBe(true);
  });

  it('does not mask a missing SDK dependency or unrelated module', () => {
    expect(
      isMissingGeminiSdk(
        missingModule(
          "Cannot find package 'ws' imported from /app/node_modules/@google/gemini-cli-core/dist/index.js"
        )
      )
    ).toBe(false);
    expect(
      isMissingGeminiSdk(missingModule("Cannot find package 'ws' imported from /app/gemini.js"))
    ).toBe(false);
    expect(isMissingGeminiSdk(new Error("Cannot find package '@google/gemini-cli-core'"))).toBe(
      false
    );
  });
});
