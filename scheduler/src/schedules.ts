export const HRRR_CRON = '8-59/10 * * * *';
export const SLOW_CRON = '7 * * * *';
export const ARCHIVE_CRON = '23 * * * *';
export const WIND100_CRON = '35 2,8,14,20 * * *';

export const SCHEDULER_CRONS = [HRRR_CRON, SLOW_CRON, ARCHIVE_CRON, WIND100_CRON] as const;
