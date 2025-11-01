/**
 * Device detection utilities for mobile site routing
 */

/**
 * Detect if the current device is mobile based on screen size and user agent
 * Uses 768px as the breakpoint (standard mobile/tablet boundary)
 */
export function isMobileDevice(): boolean {
  // Check screen width first (most reliable)
  if (typeof window !== 'undefined') {
    const width = window.innerWidth;
    if (width < 768) {
      return true;
    }
  }

  // Fallback to user agent detection
  if (typeof navigator !== 'undefined') {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );
  }

  return false;
}

/**
 * Check if we're currently on a mobile route
 */
export function isOnMobileRoute(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.pathname.includes('/m');
}
