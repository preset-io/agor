'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BlogPost } from '../lib/blogPosts';
import { blogPublicationTime, visibleBlogPosts } from '../lib/blogPublication';
import { BlogCard } from './BlogCard';

export function BlogPostList({ posts, initialNow }: { posts: BlogPost[]; initialNow: number }) {
  const searchParams = useSearchParams();
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const next = Math.min(
        ...posts.map((post) => blogPublicationTime(post.date)).filter((time) => time > current)
      );
      if (Number.isFinite(next)) {
        // Recheck daily for distant dates; never exceed the browser timer limit.
        timer = setTimeout(refresh, Math.min(next - current, 86_400_000));
      }
    };
    refresh();
    // Sleeping/background tabs and restored pages should catch up immediately.
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [posts]);

  return visibleBlogPosts(posts, now, searchParams.has('all')).map((post) => (
    <BlogCard key={post.slug} post={post} />
  ));
}
