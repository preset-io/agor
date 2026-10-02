import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { BlogPost } from './blogPosts';
import { blogPublicationTime, visibleBlogPosts } from './blogPublication';

const posts: BlogPost[] = [
  { slug: 'launch', title: 'Launch', description: '', author: 'Agor team', date: '2026-10-13' },
  { slug: 'older', title: 'Older', description: '', author: 'Agor team', date: '2026-01-01' },
];

test('publication is at 06:00 fixed PST in summer and winter', () => {
  for (const date of ['2026-01-13', '2026-07-13', '2026-10-13']) {
    assert.equal(blogPublicationTime(date), Date.parse(`${date}T14:00:00Z`));
  }
});

test('hides until the exact boundary, then includes the post in original order', () => {
  const boundary = Date.parse('2026-10-13T14:00:00Z');
  assert.deepEqual(visibleBlogPosts(posts, boundary - 1), [posts[1]]);
  assert.deepEqual(visibleBlogPosts(posts, boundary), posts);
  assert.deepEqual(visibleBlogPosts(posts, boundary + 1), posts);
  // 06:00 PDT is one hour too early: the anchor is PST, not local Pacific time.
  assert.deepEqual(visibleBlogPosts(posts, Date.parse('2026-10-13T06:00:00-07:00')), [posts[1]]);
});

test('all bypasses the date filter without changing ordering', () => {
  assert.deepEqual(visibleBlogPosts(posts, Date.parse('2025-01-01'), true), posts);
  assert.deepEqual(visibleBlogPosts(posts, Date.parse('2025-01-01')), []);
  assert.deepEqual(visibleBlogPosts([], Date.now()), []);
});
