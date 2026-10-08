export const HRRR_CRON = '8-59/10 * * * *';
export const SLOW_CRON = '7 * * * *';
export const ARCHIVE_CRON = '23 * * * *';
export const WIND100_CRON = '35 2,8,14,20 * * *';
// Energy Desk own ingest (Kazakhstan energy edition). GloFAS daily forecast is available from about
// 10:45 UTC; 13:15 is the retry. CAMS 00/12 UTC runs are asked 10 h 40 min after init and again 2 h
// later (ADS publication time 待考). Both workflows are idempotent: a served run is a no-op.
export const GLOFAS_CRON = '15 11,13 * * *';
export const CAMS_CRON = '40 0,10,12,22 * * *';

export const SCHEDULER_CRONS = [HRRR_CRON, SLOW_CRON, ARCHIVE_CRON, WIND100_CRON, GLOFAS_CRON, CAMS_CRON] as const;
