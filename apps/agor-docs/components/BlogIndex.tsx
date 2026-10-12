import { Suspense } from 'react';
import { blogPosts } from '../lib/blogPosts';
import { visibleBlogPosts } from '../lib/blogPublication';
import { BlogCard } from './BlogCard';
import styles from './BlogIndex.module.css';
import { BlogPostList } from './BlogPostList';

export function BlogIndex() {
  // Export only currently listed cards into the static HTML. The browser then
  // applies its current clock and query string, without needing a redeploy.
  const initialNow = Date.now();
  return (
    <div className={styles.blogWrapper}>
      <div className={styles.blogHeader}>
        <h1 className={styles.blogTitle}>Blog</h1>
        <p className={styles.blogSubtitle}>
          Updates, ideas, and deep dives on AI agent orchestration
        </p>
      </div>
      <div className={styles.grid}>
        <Suspense
          fallback={visibleBlogPosts(blogPosts, initialNow).map((post) => (
            <BlogCard key={post.slug} post={post} />
          ))}
        >
          <BlogPostList posts={blogPosts} initialNow={initialNow} />
        </Suspense>
      </div>
    </div>
  );
}
