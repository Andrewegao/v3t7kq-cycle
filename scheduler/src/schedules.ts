export const HRRR_CRON = '8-59/10 * * * *';
export const SLOW_CRON = '7 * * * *';
export const ARCHIVE_CRON = '23 * * * *';
// Whole-data bake (all models + whole maintenance, which also runs the staging and production
// native 100 m wind publishers). ECMWF open data lands about :10 after 02/08/14/20 UTC; the
// GitHub-native fallback is `30 2,8,14,20`, and this tick follows it by five minutes so an
// on-time fallback is seen by the dedupe and not doubled. Until 2026-10-10 this same tick sent
// only `staging_wind100_only`.
export const WHOLE_BAKE_CRON = '35 2,8,14,20 * * *';
// Fusion issuance: records prospective forecasts four times a day, at the fallback's own minute.
export const FUSION_ISSUE_CRON = '23 */6 * * *';
// Staging search lease renewal (24 h lease), at the fallback's own minute.
export const STAGING_SEARCH_CRON = '17 */6 * * *';
// Staging place renewal: the reviewed policy (tools/staging-place-renewal-policy.json) renews surf
// at `37 1,7,13,19` and the paragliding directory plus tides at `47 5,17`.
export const PLACE_SURF_CRON = '37 1,7,13,19 * * *';
export const PLACE_DIRECTORY_CRON = '47 5,17 * * *';
// Energy Desk own ingest (Kazakhstan energy edition). GloFAS daily forecast is available from about
// 10:45 UTC; 13:15 is the retry. CAMS 00/12 UTC runs are asked 10 h 40 min after init and again 2 h
// later (ADS publication time 待考). Both workflows are idempotent: a served run is a no-op.
export const GLOFAS_CRON = '15 11,13 * * *';
export const CAMS_CRON = '40 0,10,12,22 * * *';

export const SCHEDULER_CRONS = [
  HRRR_CRON, SLOW_CRON, ARCHIVE_CRON, WHOLE_BAKE_CRON, FUSION_ISSUE_CRON, STAGING_SEARCH_CRON,
  PLACE_SURF_CRON, PLACE_DIRECTORY_CRON, GLOFAS_CRON, CAMS_CRON,
] as const;

// Lanes whose dispatch first asks GitHub whether a run of the same workflow is already queued or
// running inside this slot. The catalog (HRRR/slow) and archive dispatches are unchanged and never
// read first: their workflows coalesce through their own concurrency groups.
export const DEDUPE_LOOKBACK_MS = 10 * 60_000;
