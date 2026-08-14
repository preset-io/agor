import { describe, expect, it } from 'vitest';
import { AGOR_ZELLIJ_CONFIG } from './unix-integration-service.js';

describe('AGOR_ZELLIJ_CONFIG', () => {
  it('uses bounded effective-home resurrection without keeping live shells indefinitely', () => {
    expect(AGOR_ZELLIJ_CONFIG).toContain('on_force_close "quit"');
    expect(AGOR_ZELLIJ_CONFIG).toContain('session_serialization true');
    expect(AGOR_ZELLIJ_CONFIG).toContain('pane_viewport_serialization true');
    expect(AGOR_ZELLIJ_CONFIG).toContain('scrollback_lines_to_serialize 1000');
    expect(AGOR_ZELLIJ_CONFIG).toContain('serialization_interval 1');
  });
});
