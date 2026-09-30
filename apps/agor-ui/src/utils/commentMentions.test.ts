import { describe, expect, it } from 'vitest';
import { commentMentionsUser } from './commentMentions';

describe('commentMentionsUser', () => {
  it('matches a bare or quoted name or email, ignoring case', () => {
    expect(commentMentionsUser('ping @Kasia Nowak please', 'Kasia Nowak')).toBe(true);
    expect(commentMentionsUser('ping @kasia nowak', 'Kasia Nowak')).toBe(true);
    expect(commentMentionsUser('what do you think @"Kasia"?', 'Kasia')).toBe(true);
    expect(commentMentionsUser('cc @kasia@example.com.', 'Kasia', 'kasia@example.com')).toBe(true);
    expect(commentMentionsUser('@Al, thoughts?', 'Al')).toBe(true);
  });

  it('does not match a handle that is only a prefix of another', () => {
    expect(commentMentionsUser('ping @Alice', 'Al')).toBe(false);
    expect(commentMentionsUser('ping @"Alice"', 'Al')).toBe(false);
    expect(commentMentionsUser('ping @al@example.community', 'Alex', 'al@example.com')).toBe(false);
  });

  it('treats regex characters in handles literally and needs a handle', () => {
    expect(commentMentionsUser('hi @a.b', 'a.b')).toBe(true);
    expect(commentMentionsUser('hi @axb', 'a.b')).toBe(false);
    expect(commentMentionsUser('hi @', undefined, undefined)).toBe(false);
  });
});
