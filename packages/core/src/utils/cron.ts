/**
 * Cron utility functions for scheduler
 *
 * Provides validation, humanization, and next/prev run calculation.
 * All times handled in UTC.
 */

import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

/**
 * Validate a cron expression
 *
 * @param cronExpression - Cron string to validate (e.g., "0 9 * * 1-5")
 * @returns true if valid, false otherwise
 */
export function isValidCron(cronExpression: string): boolean {
  try {
    CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: 'UTC',
    });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Validate a cron expression and throw detailed error if invalid
 *
 * @param cronExpression - Cron string to validate
 * @throws Error with validation message if invalid
 */
export function validateCron(cronExpression: string): void {
  try {
    CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: 'UTC',
    });
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid cron expression: ${error.message}`);
    }
    throw new Error('Invalid cron expression');
  }
}

/**
 * Convert cron expression to human-readable string
 *
 * @param cronExpression - Cron string (e.g., "0 9 * * 1-5")
 * @returns Human-readable description (e.g., "At 09:00 AM, Monday through Friday")
 *
 * @example
 * humanizeCron("0 9 * * 1-5") // "At 09:00 AM, Monday through Friday"
 * humanizeCron("0 *\/4 * * *") // "Every 4 hours"
 * humanizeCron("0 2 * * 1") // "At 02:00 AM, only on Monday"
 */
export function humanizeCron(cronExpression: string): string {
  try {
    return cronstrue.toString(cronExpression, {
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    });
  } catch (_error) {
    // Fallback to raw cron if humanization fails
    return cronExpression;
  }
}

/**
 * Get the next run time for a cron expression
 *
 * @param cronExpression - Cron string
 * @param fromDate - Date to calculate from (default: now)
 * @returns Unix timestamp (ms) of next run
 *
 * @example
 * getNextRunTime("0 9 * * 1-5") // Returns next weekday 9am in ms
 */
export function getNextRunTime(cronExpression: string, fromDate: Date = new Date()): number {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: fromDate,
    tz: 'UTC',
  });

  const nextDate = interval.next().toDate();
  return nextDate.getTime();
}

/**
 * Get the previous run time for a cron expression
 *
 * @param cronExpression - Cron string
 * @param fromDate - Date to calculate from (default: now)
 * @returns Unix timestamp (ms) of previous run
 *
 * @example
 * getPrevRunTime("0 9 * * 1-5") // Returns previous weekday 9am in ms
 */
export function getPrevRunTime(cronExpression: string, fromDate: Date = new Date()): number {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: fromDate,
    tz: 'UTC',
  });

  const prevDate = interval.prev().toDate();
  return prevDate.getTime();
}

/**
 * Get the next N run times for a cron expression
 *
 * @param cronExpression - Cron string
 * @param count - Number of runs to return
 * @param fromDate - Date to calculate from (default: now)
 * @returns Array of Unix timestamps (ms)
 *
 * @example
 * getNextRuns("0 9 * * 1-5", 5) // Returns next 5 weekday 9am times
 */
export function getNextRuns(
  cronExpression: string,
  count: number,
  fromDate: Date = new Date()
): number[] {
  const interval = CronExpressionParser.parse(cronExpression, {
    currentDate: fromDate,
    tz: 'UTC',
  });

  const runs: number[] = [];
  for (let i = 0; i < count; i++) {
    const nextDate = interval.next().toDate();
    runs.push(nextDate.getTime());
  }

  return runs;
}

/**
 * Validate cron and return validation result with error message
 *
 * @param cronExpression - Cron string to validate
 * @returns Validation result object
 */
export interface CronValidationResult {
  valid: boolean;
  error?: string;
  humanized?: string;
}

export function validateCronWithResult(cronExpression: string): CronValidationResult {
  try {
    CronExpressionParser.parse(cronExpression, {
      currentDate: new Date(),
      tz: 'UTC',
    });

    return {
      valid: true,
      humanized: humanizeCron(cronExpression),
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Invalid cron expression',
    };
  }
}

/**
 * Common cron presets for UI
 *
 * Provides quick selection options for users.
 */
export const CRON_PRESETS = {
  EVERY_HOUR: {
    cron: '0 * * * *',
    label: 'Every hour',
  },
  EVERY_4_HOURS: {
    cron: '0 */4 * * *',
    label: 'Every 4 hours',
  },
  DAILY_9AM: {
    cron: '0 9 * * *',
    label: 'Daily at 9am',
  },
  WEEKDAYS_9AM: {
    cron: '0 9 * * 1-5',
    label: 'Weekdays at 9am',
  },
  WEEKLY_MONDAY: {
    cron: '0 2 * * 1',
    label: 'Weekly (Monday 2am)',
  },
  MONTHLY: {
    cron: '0 0 1 * *',
    label: 'Monthly (1st at midnight)',
  },
} as const;

/**
 * Round a date to the nearest minute (for scheduled_run_at consistency)
 *
 * @param date - Date to round
 * @returns Date rounded to minute (seconds and milliseconds set to 0)
 *
 * @example
 * roundToMinute(new Date('2025-11-03T00:00:32Z')) // 2025-11-03T00:00:00Z
 */
export function roundToMinute(date: Date): Date {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  return rounded;
}
