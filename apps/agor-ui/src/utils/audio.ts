// src/utils/audio.ts
import type { AudioPreferences, ChimeSound, Task, TaskStatus } from '@agor/core/types';

/**
 * Map of chime sound names to their file paths in public/sounds/
 */
const CHIME_SOUNDS: Record<ChimeSound, string> = {
  'gentle-chime': '/sounds/gentle-chime.mp3',
  'notification-bell': '/sounds/notification-bell.mp3',
  '8bit-coin': '/sounds/8bit-coin.mp3',
  'retro-coin': '/sounds/retro-coin.mp3',
  'power-up': '/sounds/power-up.mp3',
  'you-got-mail': '/sounds/you-got-mail.mp3',
  'success-tone': '/sounds/success-tone.mp3',
};

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
  const chimePath = CHIME_SOUNDS[prefs.chime];
  if (!chimePath) {
    console.warn(`Unknown chime sound: ${prefs.chime}`);
    return;
  }

  try {
    // Create and configure audio element
    const audio = new Audio(chimePath);
    audio.volume = Math.max(0, Math.min(1, prefs.volume)); // Clamp between 0-1

    // Play the chime
    await audio.play();
  } catch (error) {
    // Browser blocked autoplay or audio file not found
    // This is expected behavior if user hasn't interacted with the page yet
    console.debug('Could not play task completion chime:', error);
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
  const chimePath = CHIME_SOUNDS[chime];
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
