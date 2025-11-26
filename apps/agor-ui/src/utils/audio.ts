// src/utils/audio.ts
import type { AudioPreferences, ChimeSound, Task, TaskStatus } from '@agor/core/types';

/**
 * Map of chime sound names to their filenames in public/sounds/
 */
const CHIME_SOUND_FILES: Record<ChimeSound, string> = {
  'gentle-chime': 'gentle-chime.mp3',
  'notification-bell': 'notification-bell.mp3',
  '8bit-coin': '8bit-coin.mp3',
  'retro-coin': 'retro-coin.mp3',
  'power-up': 'power-up.mp3',
  'you-got-mail': 'you-got-mail.mp3',
  'success-tone': 'success-tone.mp3',
};

/**
 * Resolve the full URL for a chime asset, respecting Vite's base path in prod.
 * Returns an absolute URL to avoid issues with Audio() constructor in some environments.
 */
function getChimeAssetPath(chime: ChimeSound | string): string | null {
  // Handle legacy or invalid chime names (silently migrate)
  let validChime: ChimeSound = chime as ChimeSound;

  // Check for legacy names that might be stored in user preferences
  if (chime === 'bell' || chime === 'default') {
    validChime = 'notification-bell';
  }

  const filename = CHIME_SOUND_FILES[validChime];
  if (!filename) {
    // Fallback to default chime if unknown
    validChime = 'gentle-chime';
  }

  const finalFilename = CHIME_SOUND_FILES[validChime];
  const baseUrl = import.meta.env?.BASE_URL ?? '/';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const relativePath = `${normalizedBase}/sounds/${finalFilename}`;

  // Convert to absolute URL to ensure Audio() can load it properly
  // This handles both localhost and hosted environments
  if (typeof window !== 'undefined') {
    return new URL(relativePath, window.location.origin).href;
  }

  return relativePath;
}

/**
 * Default audio preferences
 */
export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  enabled: false,
  chime: 'gentle-chime',
  volume: 0.5,
  minDurationSeconds: 5,
};

/**
 * Track if user has interacted with the page (required for autoplay in some browsers)
 */
let hasUserInteracted = false;

/**
 * Initialize audio context on first user interaction
 * This helps bypass browser autoplay restrictions
 */
export function initializeAudioOnInteraction(): void {
  if (hasUserInteracted) return;

  const handleInteraction = () => {
    hasUserInteracted = true;
    // Remove listeners after first interaction
    document.removeEventListener('click', handleInteraction);
    document.removeEventListener('keydown', handleInteraction);
    document.removeEventListener('touchstart', handleInteraction);
  };

  // Listen for any user interaction
  document.addEventListener('click', handleInteraction, { once: true });
  document.addEventListener('keydown', handleInteraction, { once: true });
  document.addEventListener('touchstart', handleInteraction, { once: true });
}

/**
 * Check if audio is likely to be blocked by browser autoplay policy
 * @returns Promise<boolean> - true if audio is BLOCKED, false if audio is ALLOWED
 */
export function checkAudioPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    // Use a silent data URI to avoid "no supported source" errors
    // This is a minimal valid audio file that won't make any sound
    const silentDataUri =
      'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAADhAC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAA4T0rBiNAAAAAAD/+xDEAAPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+xDEDwPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/+xDEHwPAAAGkAAAAIAAANIAAAARMQU1FMy4xMDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

    const audio = new Audio(silentDataUri);
    audio.volume = 0;

    const testPlay = audio.play();

    if (testPlay !== undefined) {
      testPlay
        .then(() => {
          audio.pause();
          resolve(false); // Audio allowed (NOT blocked)
        })
        .catch((error) => {
          // Only treat NotAllowedError as a permission block
          // NotSupportedError or other errors should not be treated as blocked
          if (error instanceof Error && error.name === 'NotAllowedError') {
            resolve(true); // Audio blocked by autoplay policy
          } else {
            resolve(false); // Other errors, assume audio is allowed
          }
        });
    } else {
      // Old browsers without promise-based play()
      resolve(false); // Assume allowed
    }
  });
}

/**
 * Check if a task meets the minimum duration threshold
 */
function meetsMinimumDuration(task: Task, minDurationSeconds: number): boolean {
  if (minDurationSeconds === 0) return true;

  // Try to use duration_ms if available
  if (task.duration_ms) {
    const durationSeconds = task.duration_ms / 1000;
    return durationSeconds >= minDurationSeconds;
  }

  // Fallback: calculate from timestamps if available
  if (task.started_at && task.completed_at) {
    const startTime = new Date(task.started_at).getTime();
    const endTime = new Date(task.completed_at).getTime();
    const durationSeconds = (endTime - startTime) / 1000;
    return durationSeconds >= minDurationSeconds;
  }

  // If we can't determine duration, allow it to play (optimistic approach)
  // The user set up audio notifications, so they probably want to hear them
  return true;
}

/**
 * Check if task status indicates natural completion (not user-stopped)
 */
function isNaturalCompletion(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Play a task completion chime based on user preferences
 *
 * @param task - The completed task
 * @param audioPreferences - User's audio preferences (optional, uses defaults if not provided)
 * @returns Promise that resolves when audio starts playing (or rejects if blocked)
 */
export async function playTaskCompletionChime(
  task: Task,
  audioPreferences?: AudioPreferences
): Promise<void> {
  const prefs = audioPreferences || DEFAULT_AUDIO_PREFERENCES;

  // Check if audio is enabled
  if (!prefs.enabled) {
    return;
  }

  // Check if task meets minimum duration
  if (!meetsMinimumDuration(task, prefs.minDurationSeconds)) {
    return;
  }

  // Check if task status is a natural completion (not user-stopped)
  if (!isNaturalCompletion(task.status)) {
    return;
  }

  // Get the chime file path
  const chimePath = getChimeAssetPath(prefs.chime);
  if (!chimePath) {
    console.warn(`Unknown chime sound: ${prefs.chime}`);
    return;
  }

  try {
    // Create and configure audio element
    const audio = new Audio(chimePath);
    audio.volume = Math.max(0, Math.min(1, prefs.volume)); // Clamp between 0-1

    // Play the chime
    const playPromise = audio.play();

    if (playPromise !== undefined) {
      await playPromise;
    }
  } catch (error) {
    // Browser blocked autoplay or audio file not found
    // This is expected behavior if user hasn't interacted with the page yet
    // Swallow the error to prevent unhandled promise rejections
    if (error instanceof Error) {
      const errorName = error.name;
      if (errorName === 'NotAllowedError') {
        console.debug(
          '🔇 Audio chime blocked by browser autoplay policy. User needs to interact with the page first.'
        );
      } else if (errorName === 'NotSupportedError') {
        console.warn('🔇 Audio format not supported:', chimePath);
      } else {
        console.debug('Could not play task completion chime:', error);
      }
    }
    // Don't rethrow - just silently fail so we don't spam the console
  }
}

/**
 * Test play a chime sound (for settings preview)
 * This can be used when user is actively interacting with settings,
 * so autoplay restrictions don't apply.
 *
 * @param chime - The chime sound to preview
 * @param volume - Volume level (0.0 to 1.0)
 */
export async function previewChimeSound(chime: ChimeSound, volume: number = 0.5): Promise<void> {
  const chimePath = getChimeAssetPath(chime);
  if (!chimePath) {
    console.warn(`Unknown chime sound: ${chime}`);
    return;
  }

  try {
    // Add cache-busting timestamp to force browser to reload the file
    const cacheBreaker = `?t=${Date.now()}`;
    const fullPath = chimePath + cacheBreaker;
    const audio = new Audio(fullPath);
    audio.volume = Math.max(0, Math.min(1, volume));
    await audio.play();
  } catch (error) {
    console.error('Failed to preview chime:', error);
    throw error; // Re-throw so UI can show error message
  }
}

/**
 * Get display name for a chime sound
 */
export function getChimeDisplayName(chime: ChimeSound): string {
  const displayNames: Record<ChimeSound, string> = {
    'gentle-chime': 'Gentle Chime',
    'notification-bell': 'Notification Bell',
    '8bit-coin': '8-Bit Coin',
    'retro-coin': 'Retro Coin',
    'power-up': 'Power Up',
    'you-got-mail': "You've Got Mail",
    'success-tone': 'Success Tone',
  };
  return displayNames[chime] || chime;
}

/**
 * Get all available chime sounds
 */
export function getAvailableChimes(): ChimeSound[] {
  return [
    'gentle-chime',
    'notification-bell',
    '8bit-coin',
    'retro-coin',
    'power-up',
    'you-got-mail',
    'success-tone',
  ];
}
