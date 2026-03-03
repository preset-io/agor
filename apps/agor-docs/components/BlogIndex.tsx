import { blogPosts } from '../lib/blogPosts';
import { BlogCard } from './BlogCard';
import styles from './BlogIndex.module.css';

export function BlogIndex() {
  return (
    <div className={styles.blogWrapper}>
      <div className={styles.blogHeader}>
        <h1 className={styles.blogTitle}>Blog</h1>
        <p className={styles.blogSubtitle}>
          Updates, ideas, and deep dives on AI agent orchestration
        </p>
      </div>
      <div className={styles.grid}>
        {blogPosts.map((post) => (
          <BlogCard key={post.slug} post={post} />
        ))}
      </div>
    </div>
  );
}
