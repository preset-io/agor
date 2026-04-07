/**
 * Gateway Context Formatting Tests
 */

import { describe, expect, it } from 'vitest';
import { formatGatewayContext } from './context';

describe('formatGatewayContext', () => {
  // ============================================================================
  // Slack
  // ============================================================================

  describe('Slack', () => {
    it('should format a Slack channel message with all fields', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#eng-backend',
        channelKind: 'Channel',
        userName: 'Max',
        userEmail: 'max@preset.io',
      });

      expect(result).toBe(
        [
          '---',
          '📡 Message via Slack',
          'Channel: #eng-backend',
          'From: Max (max@preset.io)',
          '---',
          '',
          '',
        ].join('\n')
      );
    });

    it('should format a Slack DM', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelKind: 'DM',
        userName: 'Alice',
        userEmail: 'alice@example.com',
      });

      expect(result).toContain('📡 Message via Slack');
      expect(result).toContain('DM');
      expect(result).toContain('From: Alice (alice@example.com)');
    });

    it('should format a Slack DM without channel name', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelKind: 'DM',
        userName: 'Bob',
      });

      expect(result).toContain('DM');
      expect(result).toContain('From: Bob');
      expect(result).not.toContain('Channel:');
    });

    it('should handle missing user email', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#general',
        channelKind: 'Channel',
        userName: 'Charlie',
      });

      expect(result).toContain('From: Charlie');
      expect(result).not.toContain('(');
    });

    it('should handle missing user name but present email', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#general',
        channelKind: 'Channel',
        userEmail: 'anon@example.com',
      });

      // No From line when no name or handle
      expect(result).not.toContain('From:');
    });
  });

  // ============================================================================
  // GitHub
  // ============================================================================

  describe('GitHub', () => {
    it('should format a GitHub PR context with all fields', () => {
      const result = formatGatewayContext({
        platform: 'github',
        channelName: 'preset-io/agor',
        userHandle: '@mistercrunch',
        userEmail: 'max@preset.io',
        extras: [
          'Repo: preset-io/agor',
          'Issue/PR: #123',
          'Comment: https://github.com/preset-io/agor/pull/123#issuecomment-456',
        ],
      });

      expect(result).toContain('📡 Message via GitHub');
      expect(result).toContain('Repo: preset-io/agor');
      expect(result).toContain('Issue/PR: #123');
      expect(result).toContain('From: @mistercrunch (max@preset.io)');
    });

    it('should format a GitHub context without email', () => {
      const result = formatGatewayContext({
        platform: 'github',
        channelName: 'preset-io/agor',
        userHandle: '@octocat',
        extras: ['Repo: preset-io/agor', 'Issue/PR: #42'],
      });

      expect(result).toContain('From: @octocat');
      expect(result).not.toContain('(');
    });
  });

  // ============================================================================
  // Graceful degradation
  // ============================================================================

  describe('graceful degradation', () => {
    it('should return empty string for platform-only context', () => {
      const result = formatGatewayContext({
        platform: 'slack',
      });

      // No useful details beyond the platform header → empty
      expect(result).toBe('');
    });

    it('should include context when at least channel is present', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#random',
        channelKind: 'Channel',
      });

      expect(result).toContain('Channel: #random');
      expect(result).not.toBe('');
    });

    it('should include context when only user is present', () => {
      const result = formatGatewayContext({
        platform: 'telegram',
        userName: 'TelegramUser',
      });

      expect(result).toContain('Message via Telegram');
      expect(result).toContain('From: TelegramUser');
    });

    it('should handle unknown platform type gracefully', () => {
      const result = formatGatewayContext({
        platform: 'discord' as any,
        channelName: '#lobby',
        channelKind: 'Channel',
        userName: 'DiscordUser',
      });

      expect(result).toContain('Message via Discord');
      expect(result).toContain('Channel: #lobby');
    });
  });

  // ============================================================================
  // Format integrity
  // ============================================================================

  describe('format', () => {
    it('should use markdown delimiters (---), not XML tags', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#test',
        channelKind: 'Channel',
        userName: 'Test',
      });

      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
      expect(result.startsWith('---\n')).toBe(true);
      expect(result).toContain('\n---\n');
    });

    it('should end with double newline for clean separation from message text', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#test',
        channelKind: 'Channel',
      });

      expect(result.endsWith('\n\n')).toBe(true);
    });

    it('should not duplicate email when email equals userName', () => {
      const result = formatGatewayContext({
        platform: 'slack',
        channelName: '#test',
        channelKind: 'Channel',
        userName: 'max@preset.io',
        userEmail: 'max@preset.io',
      });

      expect(result).toContain('From: max@preset.io');
      // Should NOT show "From: max@preset.io (max@preset.io)"
      expect(result).not.toContain('(max@preset.io)');
    });
  });
});
