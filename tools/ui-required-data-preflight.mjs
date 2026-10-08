// Mirror one mandatory shared-read data route before staging build and upload. Header-only: the
// body is cancelled, never buffered. This does not replace the guarded final verifier.
//
// The probe is `/data-atmos/airports/airports.json`: staging serves it through the read-only
// shared production release, so it carries `X-WeatherX-Release` on both origins and proves the
// staging data edge is traversing a promoted release. Until 2026-10-08 the probe was
// `/data-atmos/tides/tides.json`; on staging that route is a staging-only place family whose
// 24-hour lease is renewed by `staging-place-renewal.yml`, and the renewal has refused since
// 2026-10-07 because NOAA CO-OPS now lists 1260 reference stations against the frozen
// 1256-station roster contract (`tools/staging-place-renewal.mjs`). A staging-only lease can
// not stand in for proof that the shared data edge is healthy, so the probe moved to a route
// that staging reads from production. Production verification is unchanged.
import assert from 'node:assert/strict';
import {STAGING_ORIGIN} from './ui-staging-models.mjs';

export const REQUIRED_DATA_PATH='/data-atmos/airports/airports.json';
export const REQUIRED_DATA_URL=new URL(REQUIRED_DATA_PATH,STAGING_ORIGIN).href;
export async function requireStagingData({fetchImpl=fetch}={}){
  let response;
  try{
    response=await fetchImpl(REQUIRED_DATA_URL,{redirect:'error',signal:AbortSignal.timeout(20_000),
      headers:{Accept:'application/json','Cache-Control':'no-cache'}});
    assert.equal(response.url,REQUIRED_DATA_URL,'request redirected');
    assert.equal(response.status,200,`status ${response.status}; expected 200`);
    assert.match(response.headers.get('content-type')??'',/^application\/json(?:\s*;|$)/i,'Content-Type must be application/json');
    const release=response.headers.get('x-weatherx-release')?.trim();
    assert.ok(release,'missing X-WeatherX-Release');
    return {url:REQUIRED_DATA_URL,status:200,releaseId:release};
  }catch(error){
    throw new Error(`required staging data ${REQUIRED_DATA_URL} failed: ${error instanceof Error?error.message:String(error)}`);
  }finally{
    // Retain the predicate failure even if the transport is already closed.
    try{await response?.body?.cancel();}catch{}
  }
}
