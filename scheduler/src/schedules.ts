export const HRRR_CRON = '8-59/10 * * * *';
export const SLOW_CRON = '7 * * * *';

export const SCHEDULER_CRONS = [HRRR_CRON, SLOW_CRON] as const;
