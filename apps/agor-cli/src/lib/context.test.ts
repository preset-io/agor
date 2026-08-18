import { describe, expect, it } from 'vitest';
import { getUIUrl } from './context';

describe('getUIUrl', () => {
  it('uses the selected daemon UI for a connected deployment in source mode', () => {
    expect(getUIUrl('https://agor.example.com/base')).toBe('https://agor.example.com/base/ui');
  });

  it('uses Vite only for the explicitly identified local development deployment', () => {
    expect(getUIUrl('http://localhost:3030', true)).toBe('http://localhost:5173');
  });
});
