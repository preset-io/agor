/**
 * Time formatting utilities for consistent timestamp display across the app
 */

/**
 * Format a timestamp as human-relative time (e.g., "2h ago")
 */
export function formatRelativeTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return 'just now';
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  if (diffDay < 30) {
    const weeks = Math.floor(diffDay / 7);
    return `${weeks}w ago`;
  }
  if (diffDay < 365) {
    const months = Math.floor(diffDay / 30);
    return `${months}mo ago`;
  }

  const years = Math.floor(diffDay / 365);
  return `${years}y ago`;
}

/**
 * Format a timestamp as absolute time in ISO-ish format (local timezone)
 * Format: "2025-01-12 15:45:30"
 */
export function formatAbsoluteTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format a timestamp for tooltips: "2h ago (Jan 12, 2025, 3:45 PM)"
 */
export function formatTimestampWithRelative(timestamp: string | Date): string {
  const relative = formatRelativeTime(timestamp);
  const absolute = formatAbsoluteTime(timestamp);
  return `${relative} (${absolute})`;
}
