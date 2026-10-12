import type { BlogPost } from './blogPosts';

/** Fixed PST (UTC−08:00), deliberately not daylight-saving Pacific time. */
export function blogPublicationTime(date: string): number {
  return Date.parse(`${date}T06:00:00-08:00`);
}

export function visibleBlogPosts(posts: BlogPost[], now: number, showAll = false): BlogPost[] {
  return showAll ? posts : posts.filter((post) => blogPublicationTime(post.date) <= now);
}
