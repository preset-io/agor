import { describe, expect, it } from 'vitest';
import { teamsAddressRevocationFromActivity } from './teams-address-events';

const APP_ID = 'teams-app';

describe('teamsAddressRevocationFromActivity', () => {
  it('revokes the conversation and team on app uninstall', () => {
    expect(
      teamsAddressRevocationFromActivity(
        {
          type: 'installationUpdate',
          action: 'remove',
          conversation: { id: '19:general@thread.tacv2;messageid=1' },
          channelData: { team: { id: '19:general@thread.tacv2' } },
        },
        APP_ID
      )
    ).toEqual({
      conversationIds: ['19:general@thread.tacv2'],
      teamId: '19:general@thread.tacv2',
      reason: 'bot_removed',
    });
    expect(
      teamsAddressRevocationFromActivity(
        { type: 'installationUpdate', action: 'add', conversation: { id: 'a:1' } },
        APP_ID
      )
    ).toBeNull();
  });

  it('revokes only when the bot itself leaves the roster', () => {
    const update = (id: string) =>
      teamsAddressRevocationFromActivity(
        {
          type: 'conversationUpdate',
          conversation: { id: '19:chat@thread.v2' },
          membersRemoved: [{ id }],
        },
        APP_ID
      );
    expect(update(`28:${APP_ID}`)).toMatchObject({
      conversationIds: ['19:chat@thread.v2'],
      reason: 'bot_removed',
    });
    expect(update('29:someone-else')).toBeNull();
  });

  it('revokes deleted teams and channels', () => {
    expect(
      teamsAddressRevocationFromActivity(
        {
          type: 'conversationUpdate',
          conversation: { id: '19:general@thread.tacv2' },
          channelData: { eventType: 'teamDeleted', team: { id: '19:general@thread.tacv2' } },
        },
        APP_ID
      )
    ).toMatchObject({ teamId: '19:general@thread.tacv2', reason: 'conversation_deleted' });
    expect(
      teamsAddressRevocationFromActivity(
        {
          type: 'conversationUpdate',
          conversation: { id: '19:general@thread.tacv2' },
          channelData: { eventType: 'channelDeleted', channel: { id: '19:design@thread.tacv2' } },
        },
        APP_ID
      )
    ).toEqual({
      conversationIds: ['19:design@thread.tacv2'],
      teamId: null,
      reason: 'conversation_deleted',
    });
  });

  it('ignores ordinary messages', () => {
    expect(
      teamsAddressRevocationFromActivity({ type: 'message', conversation: { id: 'a:1' } }, APP_ID)
    ).toBeNull();
  });
});
